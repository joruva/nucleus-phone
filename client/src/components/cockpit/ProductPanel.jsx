export default function ProductPanel({ rapport }) {
  const products = rapport?.product_reference || [];
  const watchOuts = rapport?.watch_outs || [];

  if (!products.length && !watchOuts.length) return null;

  return (
    <div className="bg-jv-card border border-jv-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-jv-muted uppercase tracking-wider mb-3">Products & Watch-Outs</h3>

      {products.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {products.map((product, i) => (
            <span
              key={i}
              className="px-3 py-1 rounded-lg text-xs bg-jv-blue/10 text-jv-blue border border-jv-blue/20"
            >
              {product}
            </span>
          ))}
        </div>
      )}

      {watchOuts.length > 0 && (
        <div className="space-y-1.5">
          {watchOuts.map((wo, i) => (
            <div
              key={i}
              className="flex items-start gap-2 p-2 rounded-lg bg-jv-red/10 border border-jv-red/20"
            >
              <span className="text-jv-red shrink-0">&#9888;</span>
              <p className="text-sm">{wo}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
