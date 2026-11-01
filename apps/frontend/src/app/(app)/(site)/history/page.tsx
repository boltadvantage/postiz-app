export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { History } from '@gitroom/frontend/components/bolt-analytics/history';
export const metadata: Metadata = {
  title: 'Postiz History',
  description: '',
};
export default async function Index() {
  return <History />;
}
