export default function RapportCard({ identity, rapport }) {
  const name = identity?.name || 'Unknown Contact';
  const title = identity?.title || '';
  const company = identity?.company || '';
  const photo = identity?.profileImage;
  const linkedinUrl = identity?.linkedinUrl;

  return (
    <div className="bg-jv-card border border-jv-border rounded-xl p-4">
      <div className="flex items-start gap-4">
        {photo ? (
          <img
            src={photo}
            alt={name}
            className="w-16 h-16 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-jv-blue/20 flex items-center justify-center shrink-0">
            <span className="text-xl text-jv-blue font-bold">
              {name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold truncate">{name}</h2>
            {linkedinUrl && (
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-jv-blue hover:text-jv-blue/80 shrink-0"
                title="LinkedIn"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                </svg>
              </a>
            )}
          </div>
          {title && <p className="text-sm text-jv-muted truncate">{title}</p>}
          {company && <p className="text-sm text-jv-muted truncate">{company}</p>}
          {identity?.fitScore && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs bg-jv-blue/20 text-jv-blue">
              Fit: {identity.fitScore}
            </span>
          )}
        </div>
      </div>

      {/* Opening line */}
      {rapport?.opening_line && (
        <div className="mt-3 p-3 rounded-lg bg-jv-blue/10 border border-jv-blue/20">
          <p className="text-sm italic">&ldquo;{rapport.opening_line}&rdquo;</p>
        </div>
      )}

      {/* Rapport starters */}
      {rapport?.rapport_starters?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {rapport.rapport_starters.map((starter, i) => (
            <span
              key={i}
              className="px-3 py-1.5 rounded-full text-xs bg-jv-green/15 text-jv-green border border-jv-green/20"
            >
              {starter}
            </span>
          ))}
        </div>
      )}

      {rapport?.fallback && (
        <p className="mt-2 text-xs text-jv-amber">Using static script — Claude unavailable</p>
      )}
    </div>
  );
}
