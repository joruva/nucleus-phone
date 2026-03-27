export default function CompanyPanel({ companyData, icpScore, pipelineData }) {
  if (!companyData && !icpScore && !pipelineData?.length) return null;

  return (
    <div className="bg-jv-card border border-jv-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-jv-muted uppercase tracking-wider mb-3">Company</h3>

      {companyData && (
        <div className="space-y-1 mb-3">
          {companyData.name && <p className="font-medium">{companyData.name}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-jv-muted">
            {companyData.industry && <span>{companyData.industry}</span>}
            {(companyData.city || companyData.state) && (
              <span>{[companyData.city, companyData.state].filter(Boolean).join(', ')}</span>
            )}
            {companyData.numberofemployees && (
              <span>{companyData.numberofemployees} employees</span>
            )}
          </div>
          {companyData.company_vernacular && (
            <p className="text-xs text-jv-amber mt-1">
              Internal note: {companyData.company_vernacular}
            </p>
          )}
        </div>
      )}

      {icpScore && (
        <div className="p-2 rounded-lg bg-jv-blue/10 border border-jv-blue/20 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">ICP Score:</span>
            <span className="text-sm text-jv-blue">{icpScore.fit_score || 'N/A'}</span>
            {icpScore.persona && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-jv-card border border-jv-border">
                {icpScore.persona}
              </span>
            )}
          </div>
          {icpScore.fit_reason && (
            <p className="text-xs text-jv-muted mt-1">{icpScore.fit_reason}</p>
          )}
        </div>
      )}

      {pipelineData?.length > 0 && (
        <div>
          <p className="text-xs text-jv-muted mb-1">Pipeline</p>
          {pipelineData.map((p, i) => (
            <div key={i} className="flex items-center gap-2 text-xs py-0.5">
              <span className={`w-2 h-2 rounded-full ${
                p.status === 'enriched' ? 'bg-jv-green' : 'bg-jv-amber'
              }`} />
              <span className="text-jv-muted">{p.segment || 'unknown'}</span>
              <span className="text-jv-muted">·</span>
              <span>{p.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
