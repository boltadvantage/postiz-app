export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { Queue } from '@gitroom/frontend/components/bolt-queue/queue';
export const metadata: Metadata = {
  title: 'Postiz Queue',
  description: '',
};
export default async function Index() {
  return <Queue />;
}
