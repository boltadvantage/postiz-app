export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CanvaReturn } from '@gitroom/frontend/components/bolt-canva/canva.return';
export const metadata: Metadata = {
  title: 'Postiz Canva',
  description: '',
};
export default async function Index() {
  return <CanvaReturn />;
}
