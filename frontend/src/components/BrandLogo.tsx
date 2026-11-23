interface BrandLogoProps {
  size?: number;
  variant?: "header" | "login";
}

export default function BrandLogo({
  size = 30,
  variant = "header",
}: BrandLogoProps) {
  if (variant === "login") {
    return (
      <div className="login-brand-lockup">
        <img
          src="/favicon.svg"
          alt="Stock AI"
          width={size}
          height={size}
          className="brand-icon login-icon"
        />
        <div className="login-brand-row">
          <h1 className="login-brand">Stock</h1>
          <span className="brand-ai-pill">AI</span>
        </div>
      </div>
    );
  }

  return (
    <span className="brand-lockup">
      <img
        src="/favicon.svg"
        alt=""
        width={size}
        height={size}
        className="brand-icon"
      />
      <span className="brand-wordmark">Stock</span>
      <span className="brand-ai-pill">AI</span>
    </span>
  );
}
