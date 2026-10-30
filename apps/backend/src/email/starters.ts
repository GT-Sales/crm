import type { CustomerEmailTemplate } from '@gt-sales/contracts';

/**
 * The text each customer mail starts with until a site's owner saves its own
 * (version 0 in Settings → Email). Plain and short, and each uses only the
 * fill-ins an order nearly always has, since a missing value blocks the send:
 * `dispatched` alone needs the dispatch details and the site's address.
 * `sim_number_ready` keeps the words of the built-in mail the adapters sent
 * before phase 4, with only `{first name}` and `{SIM number}`.
 */
export const STARTER_TEMPLATES: Readonly<
  Record<CustomerEmailTemplate, { subject: string; body: string }>
> = {
  tracking_code: {
    subject: 'Your {site name} tracking code',
    body: [
      'Your tracking code is **{code}**.',
      'It expires 10 minutes after your request. Use only the most recently requested code.',
      'If you did not request this code, ignore this email.',
    ].join('\n\n'),
  },
  order_received: {
    subject: 'We received your order',
    body: [
      'Hi {first name},',
      'Thanks for your order with {site name}. We have received it and will be in touch to confirm the next steps.',
      'Did not place this order? Reply to this email and we will cancel it.',
    ].join('\n\n'),
  },
  information_needed: {
    subject: 'We need a little more information',
    body: [
      'Hi {first name},',
      'We need a little more information to keep your order moving. Please reply to this email and we will tell you what is missing.',
    ].join('\n\n'),
  },
  dispatched: {
    subject: 'Your order is on its way',
    body: [
      'Hi {first name},',
      'Your order is on its way with {courier}. Your tracking number is **{tracking number}**.',
      '[button: Track your order]({tracking link})',
      'Reply to this email if you have any questions.',
    ].join('\n\n'),
  },
  activated: {
    subject: 'Your service is active',
    body: [
      'Hi {first name},',
      'Good news: your service is now active.',
      'Reply to this email if anything does not work as expected.',
    ].join('\n\n'),
  },
  cancelled: {
    subject: 'Your order has been cancelled',
    body: [
      'Hi {first name},',
      'Your order with {site name} has been cancelled.',
      'If you did not expect this, or would like to order again, reply to this email and we will help.',
    ].join('\n\n'),
  },
  sim_number_ready: {
    subject: 'Your Canadian mobile number is ready',
    body: [
      'Your Canadian mobile number is ready, {first name}.',
      'Good news: your Canadian number has been assigned. Save it below, share it with family, and use it for any Canadian sign-up that needs a local number.',
      'Your Canadian number: **{SIM number}**',
      '**What this means:**\nThis is the Canadian mobile number that belongs to your plan. The line activates up to 24 hours before your arrival date, so it will generally be working the moment you land. Until then, you can share the number, but calls and texts to it will not be delivered.',
      'If the number does not match what you were expecting, reply to this email straight away and our team will sort it. It is much easier to fix now than after you land.',
    ].join('\n\n'),
  },
  change_approved: {
    subject: 'Your change request was approved',
    body: [
      'Hi {first name},',
      'The changes you asked for on your order with {site name} have been made.',
      'Reply to this email if anything looks wrong.',
    ].join('\n\n'),
  },
  change_rejected: {
    subject: 'About your change request',
    body: [
      'Hi {first name},',
      'We could not make the changes you asked for on your order with {site name}. Reply to this email and we will help.',
    ].join('\n\n'),
  },
};
