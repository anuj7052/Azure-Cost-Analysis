export default function MarketingBrand({ href = '/' }) {
  return <a href={href} className="marketing-brand" aria-label="Cloudledger home">
    <img src="/cloudledger-mark.svg" width="34" height="34" alt="" />
    <span>Cloudledger<span className="marketing-brand-dot">.</span></span>
  </a>;
}
