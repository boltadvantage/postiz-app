export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { Competitors } from '@gitroom/frontend/components/bolt-competitors/competitors';
export const metadata: Metadata = {
  title: 'Postiz Competitors',
  description: '',
};
export default async function Index() {
  return <Competitors />;
}
