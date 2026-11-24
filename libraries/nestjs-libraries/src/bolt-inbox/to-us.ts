// Bolt Advantage: is an inbox item aimed at the client, or is it someone
// answering another commenter in the client's thread? (X and Nostr copy every
// thread participant into a reply, and Facebook and Instagram replies to other
// people's comments land on the client's post too.)
//
// true  = a comment on our post, a reply to something we wrote, a mention, a quote
// false = a reply to someone else
// null  = can't tell from the comment alone; settled from what the inbox
//         already holds (InboxService.settleToUs)

/**
 * Facebook. Threads are one level deep, so a reply's parent is always the
 * top-level comment, even when the reply answers the Page's reply in it.
 * Facebook tags whoever a reply answers, so tags decide first.
 */
export function facebookToUs(
  c: { from?: { id?: string }; message_tags?: Array<{ id?: string }> },
  parent: { from?: { id?: string } } | null | undefined,
  pageId: string
) {
  if (!parent) return true;
  if (parent.from?.id === pageId) return true;
  const tags = (c.message_tags || []).map((t) => String(t?.id || '')).filter(Boolean);
  if (tags.includes(pageId)) return true;
  if (tags.length) return false;
  return null;
}

/** Instagram: same one-level threads; replies start with the @username they answer. */
export function instagramToUs(
  text: string,
  parent: { from?: { id?: string; username?: string }; username?: string } | null | undefined,
  self: { id: string; username?: string }
) {
  if (!parent) return true;
  const parentUser = parent.from?.username || parent.username;
  if (parent.from?.id === self.id || (self.username && parentUser === self.username)) return true;
  const handles = [...String(text || '').matchAll(/@([A-Za-z0-9._]+)/g)].map((m) => m[1].toLowerCase());
  if (self.username && handles.includes(self.username.toLowerCase())) return true;
  if (/^\s*@[A-Za-z0-9._]+/.test(text || '')) return false;
  return null;
}

/** X and Nostr: mentions and quotes are to us; a reply is to us when the post it answers is ours. */
export function replyToUs(kind: string, targetAuthor: string | null | undefined, self: string) {
  if (kind !== 'reply') return true;
  if (!targetAuthor) return null;
  return targetAuthor === self;
}
