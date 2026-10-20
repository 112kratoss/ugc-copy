/** An alert as `/api/mobile/notifications` lists it. */
export interface WebNotification {
  id: string;
  type: string;
  category: 'generation' | 'commerce' | 'social' | 'system';
  title: string;
  body: string;
  deepLink: string | null;
  isRead: boolean;
  /** How many events this alert groups ("Someone saved your post" × 7). */
  eventCount?: number;
  createdAt: string;
  updatedAt: string;
}
