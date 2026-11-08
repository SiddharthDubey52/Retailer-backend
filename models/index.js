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

// Local TAC database (collection "TACRecords"). Built only from licensed public datasets.
// HiCellTek responses are never stored here.
const tacSourceRefSchema = new Schema({
  source: { type: String, required: true },
  sourceVersion: { type: String, default: '' },
}, { _id: false })

const tacRecordSchema = new Schema({
  tac: { type: String, required: true, match: /^\d{8}$/ },
  brandName: { type: String, trim: true, maxlength: 100, default: '' },
  deviceName: { type: String, trim: true, maxlength: 160, default: '' },
  modelNumber: { type: String, trim: true, maxlength: 80, default: '' },
  source: { type: String, required: true, trim: true },
  sourceVersion: { type: String, default: '' },
  sourceUpdatedAt: { type: Date, default: null },
  // Date the record was added to the source dataset (Osmocom only). NOT a GSMA allocation date.
  sourceRecordDate: { type: Date, default: null },
  // Release year as written in the source text (MoazEb). NOT an allocation date.
  releaseYear: { type: Number, default: null },
  // No public source supplies GSMA allocation dates, so this stays null unless one does.
  allocationDate: { type: Date, default: null },
  sources: { type: [tacSourceRefSchema], default: [] },
  importedAt: { type: Date, required: true },
  lastImportId: { type: Schema.Types.ObjectId, ref: 'TACImportLog', default: null },
}, { timestamps: true, collection: 'TACRecords' })
tacRecordSchema.index({ tac: 1 }, { unique: true })
tacRecordSchema.index({ brandName: 1, deviceName: 1 })
tacRecordSchema.index({ source: 1 })

const tacImportLogSchema = new Schema({
  status: { type: String, enum: ['running', 'completed', 'failed'], required: true },
  trigger: { type: String, enum: ['cli', 'api'], required: true },
  startedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  dryRun: { type: Boolean, default: false },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  sources: { type: Schema.Types.Mixed, default: [] },
  totals: { type: Schema.Types.Mixed, default: {} },
  error: { type: String, default: '' },
}, { timestamps: true, collection: 'TACImportLogs' })
tacImportLogSchema.index({ startedAt: -1 })
// At most one running import at a time.
tacImportLogSchema.index({ status: 1 }, { unique: true, partialFilterExpression: { status: 'running' } })

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
  dealer: { type: Schema.Types.ObjectId, ref: 'Dealer', default: null },
  dealerName: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, trim: true, default: '' },
  purchaseDate: { type: Date, required: true },
  purchasePrice: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['IN_STOCK', 'SOLD'], default: 'IN_STOCK', index: true },
}, { timestamps: true })
inventorySchema.index({ imeiKeys: 1 }, { unique: true })
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
export const TACRecord = model('TACRecord', tacRecordSchema)
export const TACImportLog = model('TACImportLog', tacImportLogSchema)
export const Inventory = model('Inventory', inventorySchema)
export const Sale = model('Sale', saleSchema)
export const Expense = model('Expense', expenseSchema)
export const AuditLog = model('AuditLog', auditLogSchema)