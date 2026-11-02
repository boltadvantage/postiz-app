// Bolt Advantage: public privacy policy and data-deletion instructions, linked
// from the Meta app (required to take it Live). Reachable without signing in.
import { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Privacy Policy · Bolt Advantage',
  description: 'How Bolt Advantage handles data from connected social accounts.',
};

const CONTACT_URL = 'https://boltadvantage.com/#contact';
const UPDATED = 'November 2, 2026';

const Section = ({ id, title, children }: { id?: string; title: string; children: ReactNode }) => (
  <section id={id} className="mt-[28px]">
    <h2 className="text-[20px] font-[600] mb-[8px]">{title}</h2>
    <div className="flex flex-col gap-[8px] text-[15px] leading-[1.6] opacity-90">{children}</div>
  </section>
);

export default function PrivacyPage() {
  return (
    <div className="bg-newBgColor min-h-screen text-newTextColor">
      <main className="max-w-[760px] mx-auto px-[16px] py-[48px]">
        <h1 className="text-[30px] font-[700]">Privacy Policy</h1>
        <p className="mt-[4px] text-[14px] opacity-70">Bolt Advantage LLC · Last updated {UPDATED}</p>

        <Section title="Who we are">
          <p>
            Bolt Advantage LLC (&quot;Bolt Advantage&quot;, &quot;we&quot;) runs a private social media management
            tool at post.boltadvantage.com. We use it to schedule and publish posts, answer comments and messages,
            and report results for our own accounts and for clients who hire us to manage theirs. It is not open to
            the public and does not offer sign-ups.
          </p>
        </Section>

        <Section title="What we collect">
          <p>When an account is connected (for example a Facebook Page, Instagram, X, LinkedIn or Nostr), we store:</p>
          <ul className="list-disc ps-[22px] flex flex-col gap-[4px]">
            <li>The access token the platform gives us, plus the account&apos;s name, ID and profile picture.</li>
            <li>Posts we create or schedule, and the images or videos attached to them.</li>
            <li>
              Public engagement on those accounts: comments, mentions, replies, and the public name and picture of
              the people who wrote them.
            </li>
            <li>Direct messages sent to the account, where the platform allows it.</li>
            <li>Statistics such as followers, reach and engagement.</li>
          </ul>
          <p>We do not collect passwords for connected accounts; sign-in happens on the platform itself.</p>
        </Section>

        <Section title="How we use it">
          <p>
            Only to provide our service to the account owner: publishing the posts they approve, showing them
            comments and messages so they can respond, and reporting performance and costs. We do not sell or rent
            this data, use it for advertising, or share it with anyone other than the account owner and the people
            at Bolt Advantage who work on that account, except where the law requires it.
          </p>
        </Section>

        <Section title="Where it is kept">
          <p>
            Data is stored on a server we own and operate in the United States, reached only through an encrypted
            (HTTPS) connection and protected by sign-in with two-factor authentication. Images attached to posts are
            served from a public web address so the platforms can fetch them when publishing.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            We keep data while an account is connected and we are working with its owner. When an account is
            disconnected or our work together ends, we delete its access token and stored data within 30 days,
            except records we must keep for billing or legal reasons.
          </p>
        </Section>

        <Section id="data-deletion" title="Deleting your data">
          <p>You can have your data removed at any time, in any of these ways:</p>
          <ul className="list-disc ps-[22px] flex flex-col gap-[4px]">
            <li>
              <b>Facebook or Instagram:</b> go to Facebook Settings &amp; privacy → Settings → Business integrations,
              find our app and click Remove. This cancels our access right away. Then contact us to delete what we
              already stored.
            </li>
            <li>
              <b>X, LinkedIn and others:</b> revoke our app in that platform&apos;s connected-apps settings.
            </li>
            <li>
              <b>Any account:</b> send a &quot;Data deletion request&quot; with the account name through the{' '}
              <a className="underline" href={CONTACT_URL}>
                contact form at boltadvantage.com
              </a>
              . We will delete the data within 30 days and confirm with you.
            </li>
          </ul>
          <p>
            If you commented on or messaged an account we manage and want that removed from our tool, contact us the
            same way.
          </p>
        </Section>

        <Section title="Changes and contact">
          <p>
            If this policy changes we will update the date at the top. Questions go through the{' '}
            <a className="underline" href={CONTACT_URL}>
              contact form at boltadvantage.com
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}
