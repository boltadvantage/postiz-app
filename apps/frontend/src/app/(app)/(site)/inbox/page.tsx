export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { Inbox } from '@gitroom/frontend/components/bolt-inbox/inbox';
export const metadata: Metadata = {
  title: 'Postiz Inbox',
  description: '',
};
export default async function Index() {
  return <Inbox />;
}
