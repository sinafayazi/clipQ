import type { SVGProps } from "react";
import type { Provider } from "../shared/types";

type IconProps = Omit<SVGProps<SVGSVGElement>, "stroke" | "width" | "height"> & {
  size?: number;
  stroke?: number;
};

function Icon({ size = 20, stroke = 1.5, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6.8v10.4L18.2 12 9 6.8z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PrevIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 5v14" />
      <path d="M18 5v14L8 12l10-7z" />
    </Icon>
  );
}

export function NextIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 5v14" />
      <path d="M6 5v14l10-7L6 5z" />
    </Icon>
  );
}

export function SkipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 5v14l8.5-7L5 5z" />
      <path d="M13.5 5v14L22 12l-8.5-7z" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function GripIcon(props: IconProps) {
  return (
    <Icon {...props}>
      {[7, 12, 17].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.1" fill="currentColor" stroke="none" />
          <circle cx="15" cy={y} r="1.1" fill="currentColor" stroke="none" />
        </g>
      ))}
    </Icon>
  );
}

export function UpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 14l6-6 6 6" />
    </Icon>
  );
}

export function DownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 10l6 6 6-6" />
    </Icon>
  );
}

export function BanIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.4 6.4l11.2 11.2" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Icon>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 6H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
      <path d="M15 16l5-4-5-4" />
      <path d="M9 12h11" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 6H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3" />
      <path d="M14 4h6v6" />
      <path d="M12 12l8-8" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
      <path d="M10.2 4.6 2.6 18.2A2 2 0 0 0 4.4 21h15.2a2 2 0 0 0 1.8-2.8L13.8 4.6a2 2 0 0 0-3.6 0z" />
    </Icon>
  );
}

export function LiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12a7 7 0 0 1 14 0" />
      <path d="M8.5 12a3.5 3.5 0 0 1 7 0" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function KickMark(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h5v6.2L16.8 4H22l-7.4 8L22 20h-5.2L11 13.8V20H6V4z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ProviderIcon({ provider, ...props }: IconProps & { provider: Provider }) {
  switch (provider) {
    case "kick":
      return <KickMark {...props} />;
    case "youtube":
      return (
        <Icon {...props}>
          <rect x="3" y="6" width="18" height="12" rx="3" />
          <path d="M10.5 9.5v5L15 12l-4.5-2.5z" fill="currentColor" stroke="none" />
        </Icon>
      );
    case "twitch":
      return (
        <Icon {...props}>
          <path d="M6 4h13v9l-4 4h-4l-2 2H7v-2H4V7l2-3z" />
          <path d="M11 8v4M15 8v4" />
        </Icon>
      );
    case "tiktok":
      return (
        <Icon {...props}>
          <path d="M14 4v9.2a4.2 4.2 0 1 1-3-4" />
          <path d="M14 7.5c1.6 1.3 3.4 2 5.5 2.1V13" />
        </Icon>
      );
    case "instagram":
      return (
        <Icon {...props}>
          <rect x="4" y="4" width="16" height="16" rx="4.5" />
          <circle cx="12" cy="12" r="3.6" />
          <circle cx="16.6" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
        </Icon>
      );
    case "x":
      return (
        <Icon {...props}>
          <path d="M5 5l14 14M14.5 5H19l-6.2 7.1M9.5 19H5l6.3-7.2" />
        </Icon>
      );
    case "streamable":
      return (
        <Icon {...props}>
          <circle cx="12" cy="12" r="8" />
          <path d="M10 9.2v5.6L15.2 12 10 9.2z" fill="currentColor" stroke="none" />
        </Icon>
      );
  }
}
