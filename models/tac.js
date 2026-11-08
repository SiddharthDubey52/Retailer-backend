// TAC models live on the separate TAC cluster connection (config/database.js -> tacConnection).
// Never import these into the main connection. Built only from licensed public datasets;
// HiCellTek responses are never stored here.
import mongoose from 'mongoose'
import { tacConnection } from '../config/database.js'

const { Schema } = mongoose

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

export const TACRecord = tacConnection.model('TACRecord', tacRecordSchema)
export const TACImportLog = tacConnection.model('TACImportLog', tacImportLogSchema)
