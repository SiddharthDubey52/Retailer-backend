import mongoose from 'mongoose'

export async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required to start the API')
  }

  mongoose.set('strictQuery', true)
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'mobile_shop',
  })
  console.info(`MongoDB connected: ${mongoose.connection.host}`)
}