interface AstreloLogoProps {
  className?: string;
}

export default function AstreloLogo({ className = 'w-5 h-5' }: AstreloLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="astreloGradient" x1="20%" y1="0%" x2="90%" y2="100%">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="45%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path
        d="M50 8
           C52 8 53.5 9 54.4 10.8
           L77 70
           C78.2 73 76 76 73 74.5
           L51.6 58
           C50.6 57.2 49.4 57.2 48.4 58
           L27 74.5
           C24 76.5 21.5 73.5 23 70.5
           L45.6 10.8
           C46.5 9 48 8 50 8 Z"
        fill="url(#astreloGradient)"
      />
    </svg>
  );
}
