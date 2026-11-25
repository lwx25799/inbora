import type * as React from "react";

export function BrandSymbol({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M68 24 H78 A8 8 0 0 1 86 32 V52 A8 8 0 0 1 78 60 H72 A12 12 0 0 0 60 72 V184 A12 12 0 0 0 72 196 H184 A12 12 0 0 0 196 184 V72 A12 12 0 0 0 184 60 H178 A8 8 0 0 1 170 52 V32 A8 8 0 0 1 178 24 H188 A44 44 0 0 1 232 68 V188 A44 44 0 0 1 188 232 H68 A44 44 0 0 1 24 188 V68 A44 44 0 0 1 68 24 Z" />
      <rect x="109" y="24" width="38" height="36" rx="10" />
      <rect x="109" y="84" width="38" height="88" rx="10" />
    </svg>
  );
}

export function BrandTile({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground shadow-xs inset-shadow-[0_1px_rgba(255,255,255,0.22)] ${className}`}
      style={{ width: size, height: size }}
    >
      <BrandSymbol size={Math.round(size * 0.62)} />
    </span>
  );
}

export function BrandWordmark({
  height = 15,
  className = "",
}: {
  height?: number;
  className?: string;
}): React.ReactElement {
  const width = Math.round((height / 176) * 544);
  return (
    <svg
      viewBox="0 0 544 176"
      width={width}
      height={height}
      fill="currentColor"
      aria-label="inbora"
      className={className}
    >
      <g transform="translate(20 -38)">
        <rect x="0" y="58" width="22" height="22" rx="6" />
        <rect x="0" y="96" width="22" height="96" rx="4" />
        <path d="M44 96 H65 V111 C72 99 84 93 97 93 C113 93 122 104 122 124 V192 H100 V128 C100 116 94 111 85 111 C74 111 66 119 66 132 V192 H44 Z" />
        <path
          fillRule="evenodd"
          d="M144 58 H166 V109 C173 98 184 93 196 93 C216 93 230 112 230 144 C230 176 216 195 196 195 C184 195 173 190 166 179 V192 H144 Z M188 112 C174 112 166 124 166 144 C166 164 174 176 188 176 C201 176 208 164 208 144 C208 124 201 112 188 112 Z"
        />
        <path
          fillRule="evenodd"
          d="M292 93 C318 93 336 113 336 144 C336 175 318 195 292 195 C266 195 248 175 248 144 C248 113 266 93 292 93 Z M292 112 C278 112 270 124 270 144 C270 164 278 176 292 176 C306 176 314 164 314 144 C314 124 306 112 292 112 Z"
        />
        <path d="M356 96 H377 V112 C383 100 393 94 406 94 H413 V115 H404 C387 115 378 123 378 139 V192 H356 Z" />
        <path
          fillRule="evenodd"
          d="M482 96 H504 V192 H483 V179 C476 190 465 195 453 195 C433 195 419 176 419 144 C419 112 433 93 453 93 C465 93 476 98 482 109 Z M461 112 C448 112 441 124 441 144 C441 164 448 176 461 176 C475 176 482 164 482 144 C482 124 475 112 461 112 Z"
        />
      </g>
    </svg>
  );
}
