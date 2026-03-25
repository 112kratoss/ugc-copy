"use client";

export function HoverVideo({ src, className }: { src: string; className?: string }) {
  return (
    <video
      src={src}
      muted
      loop
      playsInline
      className={className}
      onMouseEnter={(e) => {
        void e.currentTarget.play().catch(() => {});
      }}
      onMouseLeave={(e) => {
        e.currentTarget.pause();
        e.currentTarget.currentTime = 0;
      }}
    />
  );
}
