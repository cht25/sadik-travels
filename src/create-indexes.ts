import mongoose from 'mongoose';
import { validateConfig } from './config.js';
import { connectMongo, UserModel, OtpModel, SessionModel, BookingModel, PaymentModel, SupportTicketModel, NotificationModel, ContentModel, TemplateModel, DeliveryModel, AuditModel } from './store.js';

validateConfig();
await connectMongo();
try {
  await Promise.all([UserModel, OtpModel, SessionModel, BookingModel, PaymentModel, SupportTicketModel, NotificationModel, ContentModel, TemplateModel, DeliveryModel, AuditModel].map(model => model.createIndexes()));
  console.log('Sadik Travels database indexes are ready');
} finally {
  await mongoose.disconnect();
}
