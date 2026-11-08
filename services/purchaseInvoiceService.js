// Purchase invoice rules shared by the invoice and inventory routes.
//
// Quantity invariant (always true): addedQuantity + remainingQuantity === totalQuantity,
// 0 <= addedQuantity <= totalQuantity, and addedQuantity === number of stock items linked to the invoice.
// Every change happens through a conditional atomic update inside the same MongoDB transaction that
// creates, moves or deletes the stock item, so a failed stock write also rolls the count back, and
// concurrent entries can never push an invoice past its quantity.
import mongoose from 'mongoose'
import { PurchaseInvoice } from '../models/index.js'

export const INVOICE_STATUS = { PENDING: 'Pending', PARTIAL: 'Partially Added', COMPLETED: 'Completed' }

export const invoiceStatus = (invoice) => (
  invoice.addedQuantity <= 0 ? INVOICE_STATUS.PENDING
    : invoice.addedQuantity >= invoice.totalQuantity ? INVOICE_STATUS.COMPLETED
      : INVOICE_STATUS.PARTIAL
)

/** Mongo filter for a computed status (status is never stored or trusted from input). */
export function statusFilter(status) {
  if (status === INVOICE_STATUS.PENDING || status === 'pending') return { addedQuantity: 0 }
  if (status === INVOICE_STATUS.COMPLETED || status === 'completed') return { remainingQuantity: 0 }
  if (status === INVOICE_STATUS.PARTIAL || status === 'partial') return { addedQuantity: { $gt: 0 }, remainingQuantity: { $gt: 0 } }
  return {}
}

const httpError = (message, status, code) => Object.assign(new Error(message), { status, code })

/** Public representation. Amounts are null unless financial access is granted; storage ids are never exposed. */
export function serializeInvoice(invoice, granted) {
  const doc = typeof invoice.toObject === 'function' ? invoice.toObject() : { ...invoice }
  const file = doc.invoiceFile
  return {
    _id: doc._id,
    dealer: doc.dealer,
    dealerName: doc.dealerName,
    invoiceNumber: doc.invoiceNumber,
    invoiceDate: doc.invoiceDate,
    totalPurchaseAmount: granted ? doc.totalPurchaseAmount : null,
    totalQuantity: doc.totalQuantity,
    addedQuantity: doc.addedQuantity,
    remainingQuantity: doc.remainingQuantity,
    status: invoiceStatus(doc),
    brand: doc.brand,
    notes: doc.notes,
    attachment: file ? { originalName: file.originalName, mimeType: file.mimeType, size: file.size, uploadedAt: file.uploadedAt } : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** Stock fields that come from the invoice (the invoice is the source of truth). */
export const stockFieldsFromInvoice = (invoice) => ({
  purchaseInvoiceId: invoice._id,
  dealer: invoice.dealer,
  dealerName: invoice.dealerName,
  invoiceNumber: invoice.invoiceNumber,
  purchaseDate: invoice.invoiceDate,
})

/** Takes one unit from the invoice. Throws 404/409 if the invoice is missing or already complete. */
export async function reserveInvoiceSlot(invoiceId, session) {
  if (!mongoose.isValidObjectId(invoiceId)) throw httpError('Select a valid purchase invoice.', 400, 'INVALID_INVOICE')
  const invoice = await PurchaseInvoice.findOneAndUpdate(
    { _id: invoiceId, remainingQuantity: { $gt: 0 } },
    { $inc: { addedQuantity: 1, remainingQuantity: -1 } },
    { new: true, session },
  )
  if (invoice) return invoice
  const existing = await PurchaseInvoice.findById(invoiceId).session(session).select('invoiceNumber totalQuantity addedQuantity').lean()
  if (!existing) throw httpError('The selected purchase invoice was not found.', 404, 'INVOICE_NOT_FOUND')
  throw httpError(`Invoice ${existing.invoiceNumber} is complete: all ${existing.totalQuantity} phones have already been added.`, 409, 'INVOICE_QUANTITY_EXCEEDED')
}

/** Gives one unit back (stock item deleted or moved to another invoice). */
export async function releaseInvoiceSlot(invoiceId, session) {
  if (!invoiceId) return null
  const invoice = await PurchaseInvoice.findOneAndUpdate(
    { _id: invoiceId, addedQuantity: { $gt: 0 } },
    { $inc: { addedQuantity: -1, remainingQuantity: 1 } },
    { new: true, session },
  )
  if (!invoice) throw httpError('Invoice quantities are inconsistent; the change was not saved.', 409, 'INVOICE_COUNT_INCONSISTENT')
  return invoice
}

/** Runs fn inside a transaction (Atlas replica sets support this). */
export async function inTransaction(fn) {
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => { result = await fn(session) })
    return result
  } finally {
    await session.endSession()
  }
}
