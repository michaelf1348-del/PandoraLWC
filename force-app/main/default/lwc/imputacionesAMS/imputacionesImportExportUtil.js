/** Cabecera CSV de exportaci�n (compatible con plantilla de importaci�n + Id). */
export const CSV_EXPORT_HEADER =
    'CaseNumber;Horas;Fecha;NoFacturable;Comentario;ImputacionId';

/**
 * Huella de una fila importada para detectar duplicados exactos.
 */
export function importLineFingerprint(p) {
    if (!p) {
        return '';
    }
    return [
        String(p.caseNumber || '').trim(),
        String(p.fecha || ''),
        String(p.hours),
        String(p.comment || '').trim(),
        p.noFacturable === true ? '1' : '0',
        p.imputingUserId || ''
    ].join('|');
}

/** N�mero de filas que son copias exactas de otra (segunda aparici�n en adelante). */
/** Variantes de numero de caso para busqueda (Excel puede quitar ceros o añadir .0). */
export function caseNumberLookupKeys(caseNumber) {
    let s = String(caseNumber == null ? '' : caseNumber).trim();
    if (!s) {
        return [];
    }
    if (/^\d+\.0+$/.test(s)) {
        s = String(parseInt(s, 10));
    }
    const keys = [s];
    if (/^\d+$/.test(s)) {
        const bare = String(parseInt(s, 10));
        if (bare !== s) {
            keys.push(bare);
        }
        for (const width of [6, 7, 8, 9, 10, 12]) {
            const padded = bare.padStart(width, '0');
            if (padded !== s && !keys.includes(padded)) {
                keys.push(padded);
            }
        }
    }
    return keys;
}

export function normalizeImportCaseNumber(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) {
        return '';
    }
    if (/^\d+\.0+$/.test(s)) {
        s = String(parseInt(s, 10));
    }
    return s;
}

export function countExactDuplicateImportLines(parsed) {
    const seen = new Map();
    let extra = 0;
    (parsed || []).forEach((p) => {
        const fp = importLineFingerprint(p);
        const n = (seen.get(fp) || 0) + 1;
        seen.set(fp, n);
        if (n > 1) {
            extra += 1;
        }
    });
    return extra;
}

export function escapeCsvCell(value) {
    const s = value == null ? '' : String(value);
    if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export function formatBooleanForCsvExport(flag) {
    return flag === true ? 'true' : 'false';
}

/** Evita que Excel convierta CaseNumber a numero y pierda ceros a la izquierda. */
export function formatCaseNumberForCsvExport(caseNumber) {
    const s = caseNumber == null ? '' : String(caseNumber).trim();
    if (!s) {
        return '';
    }
    if (/^\d+$/.test(s)) {
        return `'${s}`;
    }
    return s;
}

/**
 * Construye CSV UTF-8 con BOM para Excel.
 */
export function buildExportCsvContent(rows) {
    const lines = [CSV_EXPORT_HEADER];
    (rows || []).forEach((r) => {
        lines.push(
            [
                escapeCsvCell(formatCaseNumberForCsvExport(r.caseNumber)),
                escapeCsvCell(r.hours),
                escapeCsvCell(r.isoDate),
                escapeCsvCell(formatBooleanForCsvExport(r.noFacturable === true)),
                escapeCsvCell(r.comment),
                escapeCsvCell(r.imputationId)
            ].join(';')
        );
    });
    return `\ufeff${lines.join('\r\n')}`;
}

/**
 * Descarga CSV en el navegador (compatible con Lightning Web Security).
 * LWS bloquea Blob con MIME text/csv; usamos text/plain o data URI.
 */
export function downloadTextFile(fileName, textContent, ownerDocument) {
    const doc = ownerDocument || (typeof document !== 'undefined' ? document : null);
    const body = doc && (doc.body || doc.documentElement);
    if (!body) {
        throw new Error('No se pudo iniciar la descarga en este contexto.');
    }
    const a = doc.createElement('a');
    a.download = fileName && String(fileName).trim() ? String(fileName).trim() : 'export.csv';
    a.rel = 'noopener noreferrer';
    Object.assign(a.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '2px',
        height: '2px',
        opacity: '0.02',
        overflow: 'hidden',
        pointerEvents: 'none'
    });

    const text = textContent == null ? '' : String(textContent);
    let href = null;
    let revoke = null;

    try {
        const blob = new Blob([text], { type: 'text/plain' });
        href = URL.createObjectURL(blob);
        revoke = href;
    } catch (e) {
        href = null;
    }

    if (!href) {
        href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
    }

    a.href = href;
    body.appendChild(a);
    a.click();
    window.setTimeout(() => {
        if (revoke) {
            try {
                URL.revokeObjectURL(revoke);
            } catch (ignore) {
                /* ignore */
            }
        }
        if (a.parentNode) {
            a.parentNode.removeChild(a);
        }
    }, 500);
}
