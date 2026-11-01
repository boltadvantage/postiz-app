'use client';
import { FC, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import Link from 'next/link';

export const MenuItem: FC<{ label: string; icon: ReactNode; path: string; onClick?: () => void; badge?: number }> = ({
  label,
  icon,
  path,
  onClick,
  badge,
}) => {
  const currentPath = usePathname();
  const isActive = currentPath.indexOf(path) === 0;

  const className = clsx(
    'group w-full minCustom:h-[54px] custom:h-[44px] py-[8px] px-[6px] minCustom:gap-[4px] custom:gap-[2px] flex flex-col font-[600] items-center justify-center rounded-[12px] hover:text-textItemFocused hover:bg-boxFocused transition-colors',
    isActive ? 'text-textItemFocused bg-boxFocused' : 'text-textItemBlur'
  );

  const inner = (
    <>
      <div className="custom:scale-90 transition-transform relative">
        {icon}
        {/* Bolt Advantage: unread count (inbox) */}
        {!!badge && (
          <span className="absolute -top-[7px] -end-[10px] min-w-[17px] h-[17px] px-[4px] rounded-full bg-red-500 text-white text-[10px] leading-none font-[600] flex items-center justify-center">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </div>
      <div className="custom:text-[9px] minCustom:text-[10px] leading-[1.1] text-center">
        {label}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button onClick={onClick} title={label} className={className}>
        {inner}
      </button>
    );
  }

  return (
    <Link
      prefetch={true}
      href={path}
      title={badge ? `${label} (${badge})` : label}
      {...path.indexOf('http') === 0 && { target: '_blank' }}
      className={className}
    >
      {inner}
    </Link>
  );
};
