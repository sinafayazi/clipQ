import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  BanIcon as HiBanIcon,
  Cancel01Icon,
  DragDropVerticalIcon,
  ExternalLinkIcon,
  InstagramIcon,
  Link01Icon,
  LiveStreaming01Icon,
  Logout03Icon,
  Menu01Icon,
  MusicNote03Icon,
  NextIcon as HiNextIcon,
  PlayIcon as HiPlayIcon,
  PreviousIcon as HiPreviousIcon,
  Settings02Icon,
  SkipForwardIcon,
  TiktokIcon,
  TwitchIcon,
  UnavailableIcon,
  XIcon,
  YoutubeIcon,
} from "@hugeicons/core-free-icons";
import type { Provider } from "../shared/types";

type IconProps = {
  size?: number;
  stroke?: number;
  className?: string;
};

type HugeIconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Hi({ icon, size = 20, stroke = 1.5, className }: IconProps & { icon: HugeIconData }) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      color="currentColor"
      strokeWidth={stroke}
      className={className}
      aria-hidden="true"
    />
  );
}

export function PlayIcon(props: IconProps) {
  return <Hi icon={HiPlayIcon} {...props} />;
}

export function PrevIcon(props: IconProps) {
  return <Hi icon={HiPreviousIcon} {...props} />;
}

export function NextIcon(props: IconProps) {
  return <Hi icon={HiNextIcon} {...props} />;
}

export function SkipIcon(props: IconProps) {
  return <Hi icon={SkipForwardIcon} {...props} />;
}

export function CloseIcon(props: IconProps) {
  return <Hi icon={Cancel01Icon} {...props} />;
}

export function MenuIcon(props: IconProps) {
  return <Hi icon={Menu01Icon} {...props} />;
}

export function GripIcon(props: IconProps) {
  return <Hi icon={DragDropVerticalIcon} {...props} />;
}

export function UpIcon(props: IconProps) {
  return <Hi icon={ArrowUp01Icon} {...props} />;
}

export function DownIcon(props: IconProps) {
  return <Hi icon={ArrowDown01Icon} {...props} />;
}

export function BanIcon(props: IconProps) {
  return <Hi icon={HiBanIcon} {...props} />;
}

export function SettingsIcon(props: IconProps) {
  return <Hi icon={Settings02Icon} {...props} />;
}

export function LogoutIcon(props: IconProps) {
  return <Hi icon={Logout03Icon} {...props} />;
}

export function ExternalIcon(props: IconProps) {
  return <Hi icon={ExternalLinkIcon} {...props} />;
}

export function AlertIcon(props: IconProps) {
  return <Hi icon={Alert02Icon} {...props} />;
}

export function LiveIcon(props: IconProps) {
  return <Hi icon={LiveStreaming01Icon} {...props} />;
}

export function QueueClosedIcon(props: IconProps) {
  return <Hi icon={UnavailableIcon} {...props} />;
}

export function ClipLinkIcon(props: IconProps) {
  return <Hi icon={Link01Icon} {...props} />;
}

export function SongNoteIcon(props: IconProps) {
  return <Hi icon={MusicNote03Icon} {...props} />;
}

/** Kick brand mark — not in Hugeicons free set. */
export function KickMark({ size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 4h5v6.2L16.8 4H22l-7.4 8L22 20h-5.2L11 13.8V20H6V4z" />
    </svg>
  );
}

export function ProviderIcon({ provider, ...props }: IconProps & { provider: Provider }) {
  switch (provider) {
    case "kick":
      return <KickMark {...props} />;
    case "youtube":
      return <Hi icon={YoutubeIcon} {...props} />;
    case "twitch":
      return <Hi icon={TwitchIcon} {...props} />;
    case "tiktok":
      return <Hi icon={TiktokIcon} {...props} />;
    case "instagram":
      return <Hi icon={InstagramIcon} {...props} />;
    case "x":
      return <Hi icon={XIcon} {...props} />;
    case "streamable":
      return <Hi icon={LiveStreaming01Icon} {...props} />;
  }
}
