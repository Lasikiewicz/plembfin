$file = ".\public\app.js"
$lines = Get-Content $file

# Lines to replace: indices 4426 to 4435 (0-based) = line numbers 4427 to 4436 (1-based)
# These are the broken "progress-section" through "hydratePosters" block in the first movie modal

$newLines = [System.Collections.Generic.List[string]]::new()
$newLines.Add('          <section class="progress-section" style="border: 0; padding-top: 0; margin-top: 0.5rem; width: 100%;">')
$newLines.Add('            <h3>Watch Status</h3>')
$newLines.Add('            <div class="progress-label-row">')
$newLines.Add('              <span>Watched on ${formatDate(movie.watched_at)}</span>')
$newLines.Add('              <span>100% complete</span>')
$newLines.Add('            </div>')
$newLines.Add('            <div class="progress-bar-track">')
$newLines.Add('              <div class="progress-bar-fill" style="width: 100%;"></div>')
$newLines.Add('            </div>')
$newLines.Add('          </section>')
$newLines.Add('        </div>')
$newLines.Add('      </header>')
$newLines.Add('')
$newLines.Add('      ${recommendations.length > 0 ? `')
$newLines.Add('        <section class="seasons-section">')
$newLines.Add('          <h3>Recommended movies</h3>')
$newLines.Add('          <div class="horizontal-scroll-row">')
$newLines.Add('            ${recommendations')
$newLines.Add('              .slice(0, 15)')
$newLines.Add('              .map((rec) => {')
$newLines.Add('                const recPoster = rec.poster_path')
$newLines.Add("                  ? ``https://image.tmdb.org/t/p/w154`${rec.poster_path}``")
$newLines.Add("                  : `"/favicon.svg`";")
$newLines.Add('                return `')
$newLines.Add('                  <div class="season-poster-card" data-immersive-movie-id="${rec.id}">')
$newLines.Add('                    <img class="season-poster-img" src="${recPoster}" alt="${escapeHtml(rec.title)}" onerror="this.src=`'/favicon.svg`';" />')
$newLines.Add('                    <span class="season-poster-name">${escapeHtml(rec.title)}</span>')
$newLines.Add('                  </div>')
$newLines.Add('                `;')
$newLines.Add('              })')
$newLines.Add('              .join("")}')
$newLines.Add('          </div>')
$newLines.Add('        </section>')
$newLines.Add('      ` : ""}')
$newLines.Add('    </div>')
$newLines.Add('  `;')
$newLines.Add('  hydratePosters(root);')
$newLines.Add('}')

# Build new file content
$before = $lines[0..4425]   # lines 1 to 4426 (0-indexed: 0 to 4425)
$after  = $lines[4436..($lines.Count - 1)]  # lines 4437 onwards (0-indexed: 4436+)

$combined = $before + $newLines.ToArray() + $after
[System.IO.File]::WriteAllLines((Resolve-Path $file), $combined, [System.Text.UTF8Encoding]::new($false))
Write-Host "Done. New line count: $($combined.Count)"
