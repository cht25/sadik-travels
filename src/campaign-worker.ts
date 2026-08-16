import type { Store, CampaignQueueItem, User } from './store.js';
import { MessagingProvider } from './providers.js';

function renderVariables(text: string | undefined, user: User, item: CampaignQueueItem) {
  const name = user.fullName || user.email || user.phone || 'traveller';
  const parts = name.split(/\s+/);
  const variables: Record<string, string> = { first_name: parts[0] || name, last_name: parts.slice(1).join(' '), booking_id: '', booking_date: '', service_name: 'Sadik Travels', amount: '' };
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key) => variables[String(key).toLowerCase()] ?? '');
}

export class CampaignWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly store: Store, private readonly messaging: MessagingProvider) {}
  start() { if (this.timer) return; this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref(); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async tick() { if (this.running) return; this.running = true; try { await this.store.activateDueCampaigns(); await this.store.recoverStaleCampaignRecipients(); const items = await this.store.listQueuedCampaignRecipients(10); for (const item of items) { const claimed=await this.store.claimCampaignRecipient(item.id); if (claimed) await this.process({ ...item, ...claimed }); } } catch (error) { console.error('Campaign worker tick failed', error instanceof Error ? error.message : 'unknown error'); } finally { this.running = false; } }
  private async process(item: CampaignQueueItem) {
    const user = item.recipient; const campaign = item.campaign;
    if (!user || !campaign) { await this.store.updateCampaignRecipient(item.id, { status: 'failed', error: 'Recipient or campaign is unavailable' }); await this.store.recalculateCampaign(item.campaignId); return; }
    try {
      if (item.channel === 'email') { if (!user.email) throw new Error('Recipient email is unavailable'); await this.messaging.sendEmail(user.email, renderVariables(campaign.subject || campaign.name, user, item), renderVariables(campaign.emailText || campaign.webMessage || campaign.name, user, item), campaign.emailHtml ? renderVariables(campaign.emailHtml, user, item) : undefined); }
      else if (item.channel === 'sms') { if (!user.phone) throw new Error('Recipient phone is unavailable'); await this.messaging.sendSms(user.phone, renderVariables(campaign.smsMessage || campaign.webMessage || campaign.name, user, item)); }
      else { await this.store.createNotification({ userId: user.id, title: renderVariables(campaign.webTitle || campaign.name, user, item), message: renderVariables(campaign.webMessage || campaign.emailText || campaign.name, user, item), channels: ['in_app'], status: 'sent', sentAt: new Date().toISOString(), createdBy: campaign.createdBy }); }
      await this.store.updateCampaignRecipient(item.id, { status: 'sent' });
    } catch (error) { await this.store.updateCampaignRecipient(item.id, { status: 'failed', error: error instanceof Error ? error.message : 'Delivery failed' }); }
    await this.store.recalculateCampaign(item.campaignId);
  }
}
