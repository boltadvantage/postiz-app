'use client';

// Bolt Advantage: a channel's picture with its platform's icon in the bottom
// corner, like the Calendar channel list — channels that share a name and
// picture (X, Nostr, Facebook) are told apart by the icon.
import { FC } from 'react';

const NO_PICTURE = '/no-picture.jpg';

export const ChannelAvatar: FC<{ picture?: string | null; platform: string; size?: number }> = ({ picture, platform, size = 36 }) => {
  const badge = Math.round(size / 2);
  return (
    <span className="relative shrink-0 inline-block" style={{ width: size, height: size }}>
      <img
        src={picture || NO_PICTURE}
        onError={(e) => {
          if (!e.currentTarget.src.endsWith(NO_PICTURE)) e.currentTarget.src = NO_PICTURE;
        }}
        className="w-full h-full rounded-[8px] object-cover"
        alt=""
      />
      <img
        src={platform === 'youtube' ? '/icons/platforms/youtube.svg' : `/icons/platforms/${platform}.png`}
        className="absolute z-10 rounded-[6px] border border-fifth"
        style={{ width: badge, height: badge, bottom: -Math.round(size / 12), insetInlineEnd: -Math.round(size / 7) }}
        alt={platform}
        title={platform}
      />
    </span>
  );
};
