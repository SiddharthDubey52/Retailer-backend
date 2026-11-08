// Invoice attachment storage: MongoDB GridFS on the TAC cluster (bucket "invoiceFiles").
// Files are stored in 255 KB chunks (never as one large document or Base64), are never public,
// and are streamed only through authenticated API routes. Metadata lives on the PurchaseInvoice
// document in the MAIN cluster.
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import multer from 'multer'
import { isTacConnected, tacConnection } from '../config/database.js'

export const MAX_INVOICE_FILE_BYTES = (Number(process.env.INVOICE_MAX_FILE_MB) || 8) * 1024 * 1024
const BUCKET = 'invoiceFiles'

// Allowed types are decided by the file's actual bytes, not by its name or the browser's claim.
const SIGNATURES = [
  { mimeType: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mimeType: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
]
const ALLOWED_EXTENSIONS = /\.(pdf|jpe?g|png)$/i
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'])

const fail = (message, status = 400, code = 'INVALID_FILE') => Object.assign(new Error(message), { status, code })

/** Multer middleware: one optional "invoiceFile" field, kept in memory (max size enforced while streaming). */
export const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INVOICE_FILE_BYTES, files: 1, fields: 20, fieldSize: 64 * 1024 },
  fileFilter: (_request, file, done) => {
    if (!ALLOWED_EXTENSIONS.test(file.originalname || '') || !ALLOWED_MIME.has(file.mimetype)) {
      return done(fail('Only PDF, JPG, JPEG and PNG files are allowed.', 415, 'UNSUPPORTED_FILE_TYPE'))
    }
    return done(null, true)
  },
}).single('invoiceFile')

/** Express wrapper turning multer errors into clear 4xx responses. */
export function handleInvoiceUpload(request, response, next) {
  invoiceUpload(request, response, (error) => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ code: 'FILE_TOO_LARGE', message: `The invoice file must be ${MAX_INVOICE_FILE_BYTES / 1024 / 1024} MB or smaller.` })
    if (error instanceof multer.MulterError) return response.status(400).json({ code: 'INVALID_UPLOAD', message: 'Upload one invoice file in the "invoiceFile" field.' })
    return response.status(error.status || 400).json({ code: error.code || 'INVALID_FILE', message: error.message })
  })
}

function bucket() {
  if (!isTacConnected()) throw fail('Invoice file storage is temporarily unavailable. Try again shortly.', 503, 'FILE_STORAGE_UNAVAILABLE')
  return new mongoose.mongo.GridFSBucket(tacConnection.db, { bucketName: BUCKET })
}

const safeName = (name) => String(name || 'invoice').replace(/[^\w.\- ()]+/g, '_').slice(-120)

/** Validates an uploaded file's content and stores it. Returns the metadata to save on the invoice. */
export async function storeInvoiceFile(file, { invoiceId, uploadedBy }) {
  if (!file?.buffer?.length) throw fail('The uploaded invoice file is empty.')
  const kind = SIGNATURES.find((s) => s.test(file.buffer))
  if (!kind) throw fail('The file content is not a valid PDF, JPG or PNG.', 415, 'UNSUPPORTED_FILE_TYPE')
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
  const originalName = safeName(file.originalname)
  const fileId = new mongoose.Types.ObjectId()
  await new Promise((resolve, reject) => {
    const upload = bucket().openUploadStreamWithId(fileId, originalName, {
      metadata: { invoiceId: String(invoiceId), uploadedBy: String(uploadedBy || ''), mimeType: kind.mimeType, sha256 },
    })
    upload.once('finish', resolve)
    upload.once('error', reject)
    upload.end(file.buffer)
  })
  return { storageProvider: 'gridfs', fileId, originalName, mimeType: kind.mimeType, size: file.buffer.length, sha256, uploadedAt: new Date() }
}

/** Best-effort delete (used for replacement, invoice deletion and rollback). */
export async function deleteInvoiceFile(fileId) {
  if (!fileId) return
  try { await bucket().delete(new mongoose.Types.ObjectId(String(fileId))) } catch (error) {
    if (!/FileNotFound|File not found/i.test(error.message)) console.error(`Could not delete invoice file ${fileId}: ${error.message}`)
  }
}

/** Streams a stored file to the response with safe headers. */
export async function streamInvoiceFile(meta, response, { download = false } = {}) {
  const store = bucket()
  const id = new mongoose.Types.ObjectId(String(meta.fileId))
  const [found] = await store.find({ _id: id }).limit(1).toArray()
  if (!found) throw fail('The invoice file could not be found.', 404, 'FILE_NOT_FOUND')
  response.setHeader('Content-Type', meta.mimeType)
  response.setHeader('Content-Length', String(found.length))
  response.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName(meta.originalName).replace(/"/g, '')}"`)
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  await new Promise((resolve, reject) => {
    store.openDownloadStream(id).once('error', reject).once('end', resolve).pipe(response)
  })
}
