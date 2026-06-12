$path = Join-Path $PSScriptRoot 'force-app\main\default\lwc\imputacionesAMS\imputacionesAMS.html'
$lines = [System.IO.File]::ReadAllLines($path)
$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $out.Add($line)
    if ($line -match '^\s+</template>\s*$' -and $i -gt 0 -and $lines[$i-1] -match 'handleAmsCreatedFilterClear') {
        # After created-filter template close: ensure catalog-tab-extra + table-title-row closes
        if ($i + 1 -lt $lines.Count -and $lines[$i+1] -match '^\s+</div>\s*$' -and $lines[$i+2] -match '^\s+</motion>\s*$') {
            # skip duplicate closes below - handled below
        }
    }
}
# Simpler: find line index of catalog-tab-extra and fix block
$text = [System.IO.File]::ReadAllText($path)
$old = @"
                                    </template>
                                    </div>
                                </div>
                                <motion class="header-right table-header-actions">
"@
$new = @"
                                    </template>
                                        </div>
                                    </div>
                                </div>
                                <motion class="header-right table-header-actions">
"@
# fix motion typos in here strings
$old = $old.Replace('<motion', '<div').Replace('</motion>', '</motion>')
$new = $new.Replace('<motion', '<div').Replace('</motion>', '</motion>')
if (-not $text.Contains($old)) {
    $old2 = @"
                                    </template>
                                    </div>
                                </div>
                                <div class="header-right table-header-actions">
"@
    $new2 = @"
                                    </template>
                                        </motion>
                                    </motion>
                                </motion>
                                <motion class="header-right table-header-actions">
"@
    $new2 = $new2.Replace('<motion', '<div').Replace('</motion>', '</motion>')
    if ($text.Contains($old2)) {
        $text = $text.Replace($old2, $new2)
    } else {
        Write-Error 'Pattern not found'
        exit 1
    }
} else {
    $text = $text.Replace($old, $new)
}
[System.IO.File]::WriteAllText($path, $text)
Write-Host 'Fixed HTML closes'
