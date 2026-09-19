export function renderEmbedTvStyles() {
  return `
    <style>
      .iptv-section {
        margin: 22px 0;
        padding: 18px;
        border: 1px solid rgba(89, 160, 255, 0.26);
        border-radius: 18px;
        background: linear-gradient(135deg, rgba(89, 160, 255, 0.1), rgba(18, 35, 56, 0.72));
      }
      .iptv-head, .iptv-toolbar, .iptv-links, .iptv-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .iptv-head { align-items: flex-start; }
      .iptv-toggle {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        color: var(--text);
        font-weight: 700;
        cursor: pointer;
      }
      .iptv-toggle input { width: 18px; height: 18px; accent-color: var(--accent); }
      .iptv-description { margin-top: 6px; color: var(--muted); line-height: 1.45; }
      .iptv-status-line { margin-top: 14px; }
      .iptv-stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 9px;
        margin-top: 14px;
      }
      .iptv-stat {
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        background: rgba(0, 0, 0, 0.14);
      }
      .iptv-stat strong { display: block; margin-bottom: 3px; font-size: 1.1rem; }
      .iptv-links { justify-content: flex-start; margin-top: 14px; }
      .iptv-links a { word-break: break-all; }
      .iptv-meta { justify-content: flex-start; margin-top: 12px; color: var(--muted); font-size: 0.86rem; }
      @media (max-width: 640px) {
        .iptv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>`;
}

export function renderEmbedTvPanel({ baseUrl = '', enabled = true } = {}) {
  const playlistUrl = `${baseUrl}/iptv/embedtv/playlist.m3u`;
  const epgUrl = `${baseUrl}/iptv/embedtv/epg.xml`;
  return `
    <section class="iptv-section" data-iptv-panel>
      <div class="iptv-head">
        <div>
          <h2>IPTV / EmbedTV</h2>
          <p class="iptv-description">Catálogo, EPG e streams HLS resolvidos pelo próprio bridge, sem transcodificação.</p>
        </div>
        <label class="iptv-toggle">
          <input type="checkbox" name="iptvEnabled" value="1"${enabled ? ' checked' : ''}>
          <span>Habilitado</span>
        </label>
      </div>
      <div class="iptv-toolbar iptv-status-line">
        <span class="status-badge status-unknown" data-iptv-status-badge>${enabled ? 'Aguardando' : 'Desativado'}</span>
        <button class="btn-secondary" type="button" id="refresh-iptv-status">Testar / atualizar EmbedTV</button>
      </div>
      <p class="indexer-message" data-iptv-status-message>${enabled ? 'Aguardando a primeira verificação.' : 'IPTV desativado nesta configuração.'}</p>
      <div class="iptv-stats">
        <div class="iptv-stat"><strong data-iptv-channels>—</strong><span class="muted">Canais</span></div>
        <div class="iptv-stat"><strong data-iptv-events>—</strong><span class="muted">Eventos</span></div>
        <div class="iptv-stat"><strong data-iptv-cache>—</strong><span class="muted">Idade do cache</span></div>
        <div class="iptv-stat"><strong data-iptv-resolution>—</strong><span class="muted">Última resolução/teste</span></div>
      </div>
      <div class="iptv-links">
        <a data-iptv-playlist href="${escapeHtml(playlistUrl)}"><span>Playlist:</span> <code>${escapeHtml(playlistUrl)}</code></a>
        <a data-iptv-epg href="${escapeHtml(epgUrl)}"><span>EPG:</span> <code>${escapeHtml(epgUrl)}</code></a>
      </div>
      <div class="iptv-meta">
        <span>Catálogo: <span data-iptv-catalog-at>não atualizado</span></span>
        <span>Upstream: <span data-iptv-upstream>não testado</span></span>
        <span>Falha: <span data-iptv-last-failure>nenhuma</span></span>
      </div>
    </section>`;
}

function escapeHtml(value) {
  return `${value || ''}`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}
