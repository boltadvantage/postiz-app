export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { Costs } from '@gitroom/frontend/components/bolt-costs/costs';
export const metadata: Metadata = {
  title: 'Postiz Client Costs',
  description: '',
};
export default async function Index() {
  return <Costs />;
}
