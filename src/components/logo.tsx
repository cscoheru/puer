import Link from "next/link";

export default function Logo() {
  return (
    <Link href="/" className="flex items-center gap-1.5 group">
      {/* Leaf SVG */}
      <svg
        viewBox="0 0 32 32"
        className="w-7 h-7 md:w-8 md:h-8 transition-transform duration-300 group-hover:rotate-12"
        fill="none"
      >
        <defs>
          <linearGradient id="leaf-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4a7c59" />
            <stop offset="50%" stopColor="#3d6b4e" />
            <stop offset="100%" stopColor="#5a8f6a" />
          </linearGradient>
        </defs>
        {/* Leaf shape */}
        <path
          d="M16 2 C16 2 8 8 6 16 C4 24 12 30 16 30 C20 30 28 24 26 16 C24 8 16 2 16 2Z"
          fill="url(#leaf-grad)"
          stroke="#2d5a3a"
          strokeWidth="0.5"
        />
        {/* Stem */}
        <path
          d="M16 28 L16 30"
          stroke="#5a3d2b"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* Vein center */}
        <path
          d="M16 4 L16 26"
          stroke="#2d5a3a"
          strokeWidth="0.8"
          opacity="0.4"
        />
        {/* Side veins */}
        <path
          d="M16 8 L11 14"
          stroke="#2d5a3a"
          strokeWidth="0.5"
          opacity="0.3"
        />
        <path
          d="M16 8 L21 14"
          stroke="#2d5a3a"
          strokeWidth="0.5"
          opacity="0.3"
        />
        <path
          d="M16 14 L10 20"
          stroke="#2d5a3a"
          strokeWidth="0.5"
          opacity="0.3"
        />
        <path
          d="M16 14 L22 20"
          stroke="#2d5a3a"
          strokeWidth="0.5"
          opacity="0.3"
        />
      </svg>

      {/* "Puêr" text */}
      <span className="text-lg md:text-xl font-bold tracking-wide" style={{ color: "#3d6b4e" }}>
        Pu<span className="relative">
          ê
          <span className="absolute -top-2 -right-0.5 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: "#5a8f6a" }}>~</span>
        </span>r
      </span>
    </Link>
  );
}
