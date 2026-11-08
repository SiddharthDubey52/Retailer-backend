import mongoose from 'mongoose'

const { Schema, model } = mongoose

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 40 },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['ADMIN'], default: 'ADMIN' },
}, { timestamps: true })
userSchema.index({ role: 1 }, { unique: true })

const dealerSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 30, default: '' },
  address: { type: String, trim: true, maxlength: 300, default: '' },
  archivedAt: { type: Date, default: null },
}, { timestamps: true })
dealerSchema.index({ name: 1, archivedAt: 1 })

const deviceModelSchema = new Schema({
  brand: { type: String, required: true, trim: true, maxlength: 80 },
  model: { type: String, required: true, trim: true, maxlength: 120 },
  modelNumber: { type: String, trim: true, maxlength: 80, default: '' },
  ram: { type: String, trim: true, maxlength: 30, default: '' },
  storage: { type: String, trim: true, maxlength: 30, default: '' },
  color: { type: String, trim: true, maxlength: 50, default: '' },
  lowStockThreshold: { type: Number, min: 0, default: 3 },
}, { timestamps: true })
deviceModelSchema.index({ brand: 1, model: 1, modelNumber: 1 })

// Purchase invoice (stock inward). Quantities are maintained atomically by services/purchaseInvoiceService.js.
const invoiceFileSchema = new Schema({
  storageProvider: { type: String, enum: ['gridfs'], required: true },
  fileId: { type: Schema.Types.ObjectId, required: true }, // GridFS file id on the TAC cluster
  originalName: { type: String, required: true, maxlength: 200 },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  uploadedAt: { type: Date, required: true },
}, { _id: false })

export const normalizeInvoiceNumber = (value) => String(value || '').toUpperCase().replace(/\s+/g, '')

const purchaseInvoiceSchema = new Schema({
  dealer: { type: Schema.Types.ObjectId, ref: 'Dealer', required: true },
  dealerName: { type: String, required: true, trim: true, maxlength: 120 },
  invoiceNumber: { type: String, required: true, trim: true, maxlength: 80 },
  invoiceNumberKey: { type: String, required: true },
  invoiceDate: { type: Date, required: true },
  totalPurchaseAmount: { type: Number, required: true, min: 0 },
  totalQuantity: { type: Number, required: true, min: 1, max: 100000, validate: Number.isInteger },
  addedQuantity: { type: Number, default: 0, min: 0 },
  remainingQuantity: { type: Number, required: true, min: 0 },
  brand: { type: String, trim: true, maxlength: 80, default: '' },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  invoiceFile: { type: invoiceFileSchema, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })
purchaseInvoiceSchema.index({ dealer: 1, invoiceNumberKey: 1 }, { unique: true })
purchaseInvoiceSchema.index({ remainingQuantity: 1, invoiceDate: -1 })
purchaseInvoiceSchema.index({ invoiceDate: -1 })
purchaseInvoiceSchema.index({ invoiceNumberKey: 1 })
purchaseInvoiceSchema.pre('validate', function setKey() {
  this.invoiceNumberKey = normalizeInvoiceNumber(this.invoiceNumber)
})

const inventorySchema = new Schema({
  deviceModel: { type: Schema.Types.ObjectId, ref: 'DeviceModel', required: true },
  brand: { type: String, required: true, trim: true },
  model: { type: String, required: true, trim: true },
  modelNumber: { type: String, trim: true, default: '' },
  ram: { type: String, trim: true, default: '' },
  storage: { type: String, trim: true, default: '' },
  color: { type: String, trim: true, default: '' },
  imei1: { type: String, required: true, trim: true },
  imei2: { type: String, trim: true, default: '' },
  serialNumber: { type: String, trim: true, maxlength: 60, default: '' },
  imeiKeys: { type: [String], required: true },
  // Last 6 digits of each IMEI, for quick stock-out search. Maintained automatically.
  imeiLastSix: { type: [String], default: [] },
  dealer: { type: Schema.Types.ObjectId, ref: 'Dealer', default: null },
  dealerName: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, trim: true, default: '' },
  // Optional link to a purchase invoice. When set, dealer/dealerName/invoiceNumber/purchaseDate are
  // snapshots kept in sync with that invoice. Older stock without an invoice keeps working unchanged.
  purchaseInvoiceId: { type: Schema.Types.ObjectId, ref: 'PurchaseInvoice', default: null },
  purchaseDate: { type: Date, required: true },
  purchasePrice: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['IN_STOCK', 'SOLD'], default: 'IN_STOCK', index: true },
}, { timestamps: true })
inventorySchema.index({ imeiKeys: 1 }, { unique: true })
inventorySchema.index({ imeiLastSix: 1, status: 1 })
inventorySchema.index({ purchaseInvoiceId: 1, createdAt: -1 }, { partialFilterExpression: { purchaseInvoiceId: { $type: 'objectId' } } })
inventorySchema.pre('validate', function setLastSix() {
  this.imeiLastSix = [...new Set((this.imeiKeys || []).map((key) => String(key).slice(-6)))]
})
inventorySchema.index({ brand: 1, model: 1, status: 1 })
inventorySchema.index({ dealer: 1, purchaseDate: -1 })

const saleSchema = new Schema({
  inventory: { type: Schema.Types.ObjectId, ref: 'Inventory', required: true, unique: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  purchasePrice: { type: Number, required: true, min: 0 },
  sellingPrice: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  additionalExpenses: { type: Number, default: 0, min: 0 },
  grossProfit: { type: Number, required: true },
  netProfit: { type: Number, required: true },
  customer: {
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
  },
  soldAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true })
saleSchema.index({ soldAt: -1 })

const expenseSchema = new Schema({
  description: { type: String, required: true, trim: true, maxlength: 200 },
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, default: Date.now, index: true },
  sale: { type: Schema.Types.ObjectId, ref: 'Sale', default: null },
}, { timestamps: true })

// Financial PIN and short-lived financial access session (one document per user).
const userSecuritySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  financialPinHash: { type: String, select: false, default: null },
  pinEnabled: { type: Boolean, default: false },
  pinUpdatedAt: { type: Date, default: null },
  failedAttempts: { type: Number, default: 0, min: 0 },
  lockedUntil: { type: Date, default: null },
  financialSession: {
    type: new Schema({ jti: String, binding: String, expiresAt: Date }, { _id: false }),
    select: false,
    default: null,
  },
}, { timestamps: true, collection: 'usersecurity' })

const auditLogSchema = new Schema({
  actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  entity: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  changes: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true })
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 })

export const User = model('User', userSchema)
export const Dealer = model('Dealer', dealerSchema)
export const DeviceModel = model('DeviceModel', deviceModelSchema)
export const PurchaseInvoice = model('PurchaseInvoice', purchaseInvoiceSchema)
export const Inventory = model('Inventory', inventorySchema)
export const Sale = model('Sale', saleSchema)
export const Expense = model('Expense', expenseSchema)
export const AuditLog = model('AuditLog', auditLogSchema)
export const UserSecurity = model('UserSecurity', userSecuritySchema)