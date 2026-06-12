public with sharing class ReporteKaufmannController {
    private static final String GESTIONES_ENTITY_API = 'Gestiones_Kaufmann__c';
    private static final String GESTIONES_REPORTE_AVANCE_FIELD = 'Reporte_Avance__c';

    /* Límites defensivos para proteger heap (6 MB sync) cuando se cargan archivos en base64. */
    private static final Integer MAX_IMAGES_PER_CALL = 20;
    private static final Integer MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB por archivo

    /** Comprueba CRUD a nivel de objeto custom antes de DML. */
    private static void assertObjectCreateable(Schema.SObjectType sot, String label) {
        if (!sot.getDescribe().isCreateable()) {
            throw new AuraHandledException('No tienes permiso para crear ' + label + '.');
        }
    }
    private static void assertObjectUpdateable(Schema.SObjectType sot, String label) {
        if (!sot.getDescribe().isUpdateable()) {
            throw new AuraHandledException('No tienes permiso para modificar ' + label + '.');
        }
    }
    // ============================================================
    // OBTENER REPORTES DISPONIBLES
    // ============================================================
    @AuraEnabled(cacheable=true)
    public static List<Report> getAvailableReports() {
        try {
            return [
                SELECT Id, Name
                FROM Report
                WITH SECURITY_ENFORCED
                ORDER BY LastViewedDate DESC NULLS LAST
                LIMIT 20
            ];
        } catch (Exception e) {
            System.debug('ERROR getAvailableReports: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener reportes disponibles: ' + e.getMessage());
        }
    }

    // ============================================================
    // EJECUTAR REPORTE Y RETORNAR JSON
    // ============================================================
    @AuraEnabled
    public static String getReportData(Id reportId) {
        try {
            if (reportId == null) {
                throw new AuraHandledException('El Id del reporte es obligatorio.');
            }
            Reports.ReportResults results = Reports.ReportManager.runReport(reportId, true);
            String rawJson = JSON.serialize(results);
            /* El motor de informes suele truncar texto largo y RTF (~255 caracteres visibles): se rellena vía SOQL por Id de fila. */
            try {
                return enrichReportJsonWithLongTextAreas(rawJson, reportId);
            } catch (Exception enrichEx) {
                System.debug(LoggingLevel.WARN, 'WARN getReportData enrich skip: ' + enrichEx.getMessage());
                return rawJson;
            }
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR getReportData: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al ejecutar el reporte: ' + e.getMessage());
        }
    }

    /** Plan de enriquecimiento por objeto (columna Id del informe → campos a consultar en SOQL). */
    private class LongTextEntityPlan {
        String entityApi;
        String idColumnKey;
        Set<String> fieldApis;

        LongTextEntityPlan(String entityApi) {
            this.entityApi = entityApi;
            this.fieldApis = new Set<String>();
        }
    }

    /**
     * Sustituye label/value truncados por el texto completo en columnas texto largo o RTF,
     * usando el Id por fila (columna Entity.Id del informe).
     * Requisito: el informe tabular debe incluir la columna «Objeto.Id» del mismo objeto que el campo largo.
     */
    private static String enrichReportJsonWithLongTextAreas(String reportJson, Id reportId) {
        if (String.isBlank(reportJson) || reportId == null) {
            return reportJson;
        }
        Reports.ReportDescribeResult rd = Reports.ReportManager.describeReport(reportId);
        Reports.ReportMetadata rm = rd.getReportMetadata();
        if (rm == null || rm.getReportFormat() != Reports.ReportFormat.TABULAR) {
            return reportJson;
        }
        Reports.ReportExtendedMetadata xm = rd.getReportExtendedMetadata();
        Map<String, Reports.DetailColumn> dcInfo = xm != null ? xm.getDetailColumnInfo() : null;
        List<String> colOrder = rm.getDetailColumns();
        if (
            dcInfo == null ||
                dcInfo.isEmpty() ||
                colOrder == null ||
                colOrder.isEmpty()
        ) {
            return reportJson;
        }

        Map<String, Integer> colIndexByKey = new Map<String, Integer>();
        for (Integer c = 0; c < colOrder.size(); c++) {
            colIndexByKey.put(colOrder[c], c);
        }

        Map<String, LongTextEntityPlan> plans = new Map<String, LongTextEntityPlan>();
        Map<String, String> idColByEntityLower = new Map<String, String>();

        for (String colKey : colOrder) {
            Reports.DetailColumn dc = dcInfo.get(colKey);
            if (dc == null) {
                continue;
            }
            String fq = colKey;
            if (String.isBlank(fq) || !fq.contains('.')) {
                continue;
            }
            Integer dot = fq.indexOf('.');
            String entityApi = fq.substring(0, dot);
            String fieldApi = fq.substring(dot + 1);
            if ('Id'.equalsIgnoreCase(fieldApi)) {
                idColByEntityLower.put(entityApi.toLowerCase(), colKey);
                continue;
            }
            Schema.SObjectType typ = Schema.getGlobalDescribe().get(entityApi);
            if (typ == null) {
                continue;
            }
            Schema.SObjectField fTok = typ.getDescribe().fields.getMap().get(fieldApi);
            if (fTok == null) {
                continue;
            }
            if (!isQueryableLongRichText(fTok.getDescribe())) {
                continue;
            }
            LongTextEntityPlan p = plans.get(entityApi);
            if (p == null) {
                p = new LongTextEntityPlan(entityApi);
                plans.put(entityApi, p);
            }
            p.fieldApis.add(fieldApi);
        }

        List<String> removeEntities = new List<String>();
        for (String ent : plans.keySet()) {
            String idCk = idColByEntityLower.get(ent.toLowerCase());
            LongTextEntityPlan lp = plans.get(ent);
            if (String.isBlank(idCk)) {
                removeEntities.add(ent);
                System.debug(
                    LoggingLevel.WARN,
                    'Long text enrich: añada la columna «' + ent + '.Id» al informe para enriquecer campos largos de ' + ent
                );
            } else {
                lp.idColumnKey = idCk;
            }
        }
        for (String rem : removeEntities) {
            plans.remove(rem);
        }
        // Fallback explícito para reportes estándar de Gestiones: evita depender 100% del formato de claves del Report API.
        if (plans.isEmpty()) {
            applyGestionesFallbackPlan(plans, idColByEntityLower, colOrder);
        }
        if (plans.isEmpty()) {
            return reportJson;
        }

        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(reportJson);
        Map<String, Object> fm = asMap(root.get('factMap'));
        if (fm.isEmpty()) {
            return reportJson;
        }
        Map<String, Object> tit = asMap(fm.get('T!T'));
        if (tit.isEmpty()) {
            return reportJson;
        }
        List<Object> rows = asListObjects(tit.get('rows'));
        if (rows.isEmpty()) {
            return reportJson;
        }

        Map<String, Set<Id>> idsByEntity = new Map<String, Set<Id>>();
        for (String ent : plans.keySet()) {
            idsByEntity.put(ent, new Set<Id>());
        }
        for (Object rowObj : rows) {
            Map<String, Object> rowMap = asMap(rowObj);
            if (rowMap.isEmpty()) {
                continue;
            }
            List<Object> cells = parseDataCells(rowMap);
            if (cells.isEmpty()) {
                continue;
            }
            for (String entApi : plans.keySet()) {
                LongTextEntityPlan pl = plans.get(entApi);
                Integer idIx = colIndexByKey.get(pl.idColumnKey);
                if (idIx == null || idIx >= cells.size()) {
                    continue;
                }
                Id rowId = extractRowIdFromCell(cells.get(idIx));
                if (rowId == null) {
                    rowId = extractRowIdFromRow(rowMap);
                }
                if (rowId != null) {
                    idsByEntity.get(entApi).add(rowId);
                }
            }
        }

        Map<String, Map<Id, SObject>> cached = new Map<String, Map<Id, SObject>>();
        for (String entApi : plans.keySet()) {
            cached.put(
                entApi,
                fetchLongTextsForEntities(
                    entApi,
                    plans.get(entApi).fieldApis,
                    idsByEntity.get(entApi)
                )
            );
        }

        Boolean changedAny = false;
        for (Object rowObj : rows) {
            Map<String, Object> rowMap = asMap(rowObj);
            if (rowMap.isEmpty()) {
                continue;
            }
            List<Object> cells = parseDataCells(rowMap);
            if (cells.isEmpty()) {
                continue;
            }
            Boolean touched = false;

            for (String entApi : plans.keySet()) {
                LongTextEntityPlan pl = plans.get(entApi);
                Integer idIx = colIndexByKey.get(pl.idColumnKey);
                if (idIx == null || idIx >= cells.size()) {
                    continue;
                }
                Id rowId = extractRowIdFromCell(cells.get(idIx));
                if (rowId == null) {
                    rowId = extractRowIdFromRow(rowMap);
                }
                if (rowId == null) {
                    continue;
                }
                SObject sob = cached.get(entApi).get(rowId);
                if (sob == null) {
                    continue;
                }

                for (String fieldApi : pl.fieldApis) {
                    String colKey = resolveReportColumnKey(dcInfo, colOrder, entApi, fieldApi);
                    if (String.isBlank(colKey)) {
                        continue;
                    }
                    Integer tgtIx = colIndexByKey.get(colKey);
                    if (tgtIx == null || tgtIx >= cells.size()) {
                        continue;
                    }
                    Object rawVal = sob.get(fieldApi);
                    String fullTxt = rawVal != null ? String.valueOf(rawVal) : '';
                    upsertRichTextCell(cells, tgtIx, fullTxt);
                    touched = true;
                    changedAny = true;
                }
            }
            if (touched) {
                rowMap.put('dataCells', cells);
            }
        }

        if (!changedAny) {
            return reportJson;
        }
        tit.put('rows', rows);
        fm.put('T!T', tit);
        root.put('factMap', fm);
        return JSON.serialize(root);
    }

    private static Map<String, Object> asMap(Object raw) {
        if (raw instanceof Map<String, Object>) {
            return (Map<String, Object>) raw;
        }
        return new Map<String, Object>();
    }

    private static List<Object> asListObjects(Object raw) {
        if (raw instanceof List<Object>) {
            return (List<Object>) raw;
        }
        return new List<Object>();
    }

    /** Encuentra la clave de columna del informe cuyo FQ coincide con Entity.Field */
    private static String resolveReportColumnKey(
        Map<String, Reports.DetailColumn> dcInfo,
        List<String> colOrder,
        String entityApi,
        String fieldApi
    ) {
        String wantNorm = fqNorm(entityApi + '.' + fieldApi);
        for (String ck : colOrder) {
            Reports.DetailColumn dc = dcInfo.get(ck);
            if (dc == null) {
                continue;
            }
            String fq = ck;
            if (String.isBlank(fq)) {
                continue;
            }
            String norm = fqNorm(fq);
            if (
                norm.equals(wantNorm) ||
                norm.endsWith('.' + fieldApi.toLowerCase()) ||
                norm.contains(fieldApi.toLowerCase())
            ) {
                return ck;
            }
        }
        return null;
    }

    /** Lista de fallback configurada via Custom Metadata PandoraLongTextFallback__mdt + fallback hardcoded Gestiones. */
    @TestVisible
    private static List<Map<String, String>> getConfiguredLongTextFallbacks() {
        List<Map<String, String>> out = new List<Map<String, String>>();
        try {
            List<PandoraLongTextFallback__mdt> mdtList = [
                SELECT Object_API_Name__c, Field_API_Name__c
                FROM PandoraLongTextFallback__mdt
                WHERE Active__c = true
            ];
            for (PandoraLongTextFallback__mdt m : mdtList) {
                if (String.isBlank(m.Object_API_Name__c) || String.isBlank(m.Field_API_Name__c)) continue;
                out.add(new Map<String, String>{
                    'object' => m.Object_API_Name__c.trim(),
                    'field'  => m.Field_API_Name__c.trim()
                });
            }
        } catch (Exception e) {
            /* Si el CMD no existe aún en la org o falla la query, continuamos con el fallback hardcoded. */
            System.debug(LoggingLevel.WARN, 'PandoraLongTextFallback__mdt no disponible: ' + e.getMessage());
        }
        if (out.isEmpty()) {
            /* Fallback de seguridad para orgs sin registros del CMD (mantiene compatibilidad histórica). */
            out.add(new Map<String, String>{ 'object' => GESTIONES_ENTITY_API, 'field' => GESTIONES_REPORTE_AVANCE_FIELD });
        }
        return out;
    }

    /**
     * Construye planes de enriquecimiento desde Custom Metadata cuando el detector automático
     * no encontró columnas «Entity.Field» en el informe. Permite añadir nuevos objetos/campos
     * sin tocar Apex: basta con crear un registro en PandoraLongTextFallback__mdt.
     */
    private static void applyGestionesFallbackPlan(
        Map<String, LongTextEntityPlan> plans,
        Map<String, String> idColByEntityLower,
        List<String> colOrder
    ) {
        List<Map<String, String>> fallbacks = getConfiguredLongTextFallbacks();
        for (Map<String, String> fb : fallbacks) {
            String entityApi = fb.get('object');
            String fieldApi = fb.get('field');
            if (String.isBlank(entityApi) || String.isBlank(fieldApi)) continue;
            if (plans.containsKey(entityApi)) continue;

            /* Verificación FLS antes de planear el SOQL: el usuario debe poder leer el campo largo. */
            Schema.SObjectType sot = Schema.getGlobalDescribe().get(entityApi);
            if (sot == null) continue;
            Map<String, Schema.SObjectField> fmap = sot.getDescribe().fields.getMap();
            Schema.SObjectField tok = fmap.get(fieldApi);
            if (tok == null || !isQueryableLongRichText(tok.getDescribe())) continue;

            String reportFieldCol = null;
            String idCol = idColByEntityLower.get(entityApi.toLowerCase());
            for (String ck : colOrder) {
                String norm = fqNorm(ck);
                if (reportFieldCol == null && norm.contains(fieldApi.toLowerCase())) {
                    reportFieldCol = ck;
                }
                if (String.isBlank(idCol) && (norm.contains('.id') || norm.endsWith('id'))) {
                    if (norm.contains(entityApi.toLowerCase())) idCol = ck;
                    else if (idCol == null) idCol = ck;
                }
            }
            if (reportFieldCol == null || String.isBlank(idCol)) continue;

            LongTextEntityPlan plan = new LongTextEntityPlan(entityApi);
            plan.idColumnKey = idCol;
            plan.fieldApis.add(fieldApi);
            plans.put(entityApi, plan);
        }
    }

    private static String fqNorm(String fq) {
        return fq.replace(' ', '').toLowerCase();
    }

    private static Boolean isQueryableLongRichText(Schema.DescribeFieldResult fr) {
        if (fr == null || !fr.isAccessible()) {
            return false;
        }
        Schema.DisplayType t = fr.getType();
        if (fr.isHtmlFormatted()) {
            return true;
        }
        if (t == Schema.DisplayType.TextArea && fr.getLength() > 255) {
            return true;
        }
        return false;
    }

    private static List<Object> parseDataCells(Map<String, Object> row) {
        Object dc = row.get('dataCells');
        return asListObjects(dc);
    }

    private static Id extractRowIdFromCell(Object cellWrapper) {
        if (!(cellWrapper instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> c = (Map<String, Object>) cellWrapper;
        Id fromVal = coerceIdCandidate(c.get('value'));
        if (fromVal != null) {
            return fromVal;
        }
        return coerceIdCandidate(c.get('label'));
    }

    private static Id extractRowIdFromRow(Map<String, Object> rowMap) {
        if (rowMap == null || rowMap.isEmpty()) return null;
        Id fromId = coerceIdCandidate(rowMap.get('id'));
        if (fromId != null) return fromId;
        Id fromKey = coerceIdCandidate(rowMap.get('key'));
        if (fromKey != null) return fromKey;
        Id fromLabel = coerceIdCandidate(rowMap.get('label'));
        if (fromLabel != null) return fromLabel;
        return null;
    }

    private static Id coerceIdCandidate(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof Map<String, Object>) {
            Map<String, Object> rm = (Map<String, Object>) raw;
            if (rm.containsKey('id')) {
                Id fromId = coerceIdCandidate(rm.get('id'));
                if (fromId != null) return fromId;
            }
            if (rm.containsKey('value')) {
                Id fromValue = coerceIdCandidate(rm.get('value'));
                if (fromValue != null) return fromValue;
            }
            if (rm.containsKey('url')) {
                Id fromUrl = coerceIdCandidate(rm.get('url'));
                if (fromUrl != null) return fromUrl;
            }
            if (rm.containsKey('label')) {
                Id fromLabel = coerceIdCandidate(rm.get('label'));
                if (fromLabel != null) return fromLabel;
            }
            return null;
        }
        String s = String.valueOf(raw).trim();
        if (s.length() != 15 && s.length() != 18) {
            Pattern embedded = Pattern.compile('([a-zA-Z0-9]{18}|[a-zA-Z0-9]{15})');
            Matcher mEmb = embedded.matcher(s);
            if (mEmb.find()) {
                s = mEmb.group(1);
            } else {
                return null;
            }
        }
        try {
            return (Id) s;
        } catch (Exception ignore) {
        }
        return null;
    }

    private static void upsertRichTextCell(List<Object> cells, Integer ix, String fullText) {
        if (!(cells.get(ix) instanceof Map<String, Object>)) {
            cells.set(
                ix,
                new Map<String, Object>{
                    'label' => fullText,
                    'value' => fullText
                }
            );
            return;
        }
        Map<String, Object> mc = (Map<String, Object>) cells.get(ix);
        mc.put('label', fullText);
        mc.put('value', fullText);
        cells.set(ix, mc);
    }

    /** SOQL sólo incluye campos existentes y accesibles (FLS aplicada en query). */
    private static Map<Id, SObject> fetchLongTextsForEntities(
        String entityApi,
        Set<String> candidateFields,
        Set<Id> idSet
    ) {
        Map<Id, SObject> accum = new Map<Id, SObject>();
        if (
            candidateFields == null ||
                candidateFields.isEmpty() ||
                idSet == null ||
                idSet.isEmpty()
        ) {
            return accum;
        }

        Schema.SObjectType sobType = Schema.getGlobalDescribe().get(entityApi);
        if (sobType == null) {
            return accum;
        }
        Map<String, Schema.SObjectField> fmap = sobType.getDescribe().fields.getMap();
        List<String> selectPieces = new List<String>{ 'Id' };
        for (String fld : candidateFields) {
            if (!fmap.containsKey(fld)) {
                continue;
            }
            if (!isQueryableLongRichText(fmap.get(fld).getDescribe())) {
                continue;
            }
            selectPieces.add(fld);
        }
        if (selectPieces.size() <= 1) {
            return accum;
        }

        String objectApi = sobType.getDescribe().getName();
        String sel = String.join(selectPieces, ', ');
        List<Id> all = new List<Id>(idSet);
        Integer i = 0;
        Integer total = all.size();
        while (i < total) {
            Integer hi = Math.min(i + 200, total);
            List<Id> chunk = new List<Id>();
            for (Integer k = i; k < hi; k++) {
                chunk.add(all[k]);
            }
            List<SObject> rows = Database.query(
                'SELECT ' + sel + ' FROM ' + objectApi + ' WHERE Id IN :chunk'
            );
            for (SObject r : rows) {
                accum.put(r.Id, r);
            }
            i = hi;
        }
        return accum;
    }

    // ============================================================
    // GUARDAR PLANTILLA DE EXCEL (compat: variante default)
    // ============================================================
    /**
     * Mantiene compatibilidad con clientes antiguos: guarda en la variante DEFAULT del reporte.
     * Si no existe, la crea. Si existen varias filas para el mismo reportId sin Variante_Id__c
     * (plantillas pre-variantes), las migra a "Variante por defecto".
     */
    @AuraEnabled
    public static void saveTemplate(String reportId, String jsonConfig) {
        try {
            if (String.isBlank(reportId)) throw new AuraHandledException('El ID del reporte es obligatorio.');
            if (String.isBlank(jsonConfig)) throw new AuraHandledException('La configuración JSON es obligatoria.');

            Plantilla_Reporte__c defaultRow = findOrPromoteDefaultVariant(reportId);
            if (defaultRow == null) {
                assertObjectCreateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
                Plantilla_Reporte__c newTemplate = new Plantilla_Reporte__c(
                    ID_del_Reporte__c = reportId,
                    Configuracion_JSON__c = jsonConfig,
                    Variante_Id__c = generateVariantId(),
                    Variante_Nombre__c = 'Variante por defecto',
                    Es_Default__c = true,
                    Es_Publica__c = true,
                    Owner_UserId__c = String.valueOf(UserInfo.getUserId()).substring(0, 18)
                );
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.CREATABLE, new List<Plantilla_Reporte__c>{ newTemplate });
                insert dec.getRecords();
            } else {
                assertObjectUpdateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
                defaultRow.Configuracion_JSON__c = jsonConfig;
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, new List<Plantilla_Reporte__c>{ defaultRow });
                update dec.getRecords();
            }
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR saveTemplate: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al guardar plantilla: ' + e.getMessage());
        }
    }

    // ============================================================
    // LEER PLANTILLA GUARDADA DE EXCEL (compat: variante default)
    // ============================================================
    @AuraEnabled
    public static String getTemplate(String reportId) {
        try {
            if (String.isBlank(reportId)) return null;
            Plantilla_Reporte__c defaultRow = findOrPromoteDefaultVariant(reportId);
            return defaultRow == null ? null : defaultRow.Configuracion_JSON__c;
        } catch (Exception e) {
            System.debug('ERROR getTemplate: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener plantilla: ' + e.getMessage());
        }
    }

    // ============================================================
    // VARIANTES DE PLANTILLA (multi-versión por reporte)
    // ============================================================

    /**
     * Wrapper serializable para retornar variantes al LWC sin exponer la fila Apex completa.
     * Incluye solo metadatos (no el JSON pesado), para minimizar payload en listVariants.
     */
    public class VariantSummary {
        @AuraEnabled public String varianteId;
        @AuraEnabled public String nombre;
        @AuraEnabled public Boolean esDefault;
        @AuraEnabled public Boolean esPublica;
        @AuraEnabled public String ownerUserId;
        @AuraEnabled public String ownerUserName;
        @AuraEnabled public Datetime lastModifiedDate;
        @AuraEnabled public Boolean canEdit;
        /* Indica si la variante tiene configuración de PPT guardada (Plantilla_Geneador_PPT__c
           con Configuracion_PPT__c no vacío). Lo computa listVariants en una query secundaria. */
        @AuraEnabled public Boolean hasPpt;
    }

    /**
     * Lista las variantes visibles para el usuario actual:
     *  - Públicas (Es_Publica__c = true): visibles para todos.
     *  - Privadas (Es_Publica__c = false): solo si el Owner_UserId__c coincide con el usuario actual.
     * Ordena: variante default primero, luego por nombre.
     */
    @AuraEnabled(cacheable=false)
    public static List<VariantSummary> listVariants(String reportId) {
        try {
            if (String.isBlank(reportId)) return new List<VariantSummary>();
            /* Promovemos plantillas legacy a "Variante por defecto" antes de listar. */
            findOrPromoteDefaultVariant(reportId);

            String currentUserId = String.valueOf(UserInfo.getUserId()).substring(0, 18);
            List<Plantilla_Reporte__c> rows = [
                SELECT Id, Variante_Id__c, Variante_Nombre__c, Es_Default__c, Es_Publica__c,
                       Owner_UserId__c, LastModifiedDate, CreatedBy.Name
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId
                AND (Es_Publica__c = true OR Owner_UserId__c = :currentUserId)
                WITH SECURITY_ENFORCED
                ORDER BY Es_Default__c DESC, Variante_Nombre__c ASC NULLS LAST
            ];

            /* Query secundaria para saber qué variantes tienen PPT guardado.
               Defensiva: si el usuario no tiene acceso a Plantilla_Geneador_PPT__c (perms
               antiguos), no rompemos el listado: simplemente todas quedan con hasPpt=false. */
            Set<String> variantIdsWithPpt = new Set<String>();
            Boolean legacyPptExists = false;
            try {
                List<Plantilla_Geneador_PPT__c> pptRows = [
                    SELECT Variante_Id__c, Configuracion_PPT__c
                    FROM Plantilla_Geneador_PPT__c
                    WHERE Name = :reportId
                    WITH SECURITY_ENFORCED
                ];
                for (Plantilla_Geneador_PPT__c p : pptRows) {
                    if (String.isBlank(p.Configuracion_PPT__c)) continue;
                    if (String.isBlank(p.Variante_Id__c)) {
                        /* Registro legacy sin Variante_Id__c → cuenta como PPT de la variante 'default'. */
                        legacyPptExists = true;
                    } else {
                        variantIdsWithPpt.add(p.Variante_Id__c);
                    }
                }
            } catch (Exception pptErr) {
                System.debug('listVariants: no se pudo leer Plantilla_Geneador_PPT__c (' + pptErr.getMessage() + '). Se omitirá el flag hasPpt.');
            }

            List<VariantSummary> out = new List<VariantSummary>();
            for (Plantilla_Reporte__c r : rows) {
                VariantSummary v = new VariantSummary();
                v.varianteId = r.Variante_Id__c;
                v.nombre = String.isBlank(r.Variante_Nombre__c) ? 'Sin nombre' : r.Variante_Nombre__c;
                v.esDefault = r.Es_Default__c == true;
                v.esPublica = r.Es_Publica__c == true;
                v.ownerUserId = r.Owner_UserId__c;
                v.ownerUserName = r.CreatedBy != null ? r.CreatedBy.Name : null;
                v.lastModifiedDate = r.LastModifiedDate;
                /* canEdit: una variante publica puede editarla cualquiera; una privada solo su creador. */
                v.canEdit = (v.esPublica == true) || currentUserId.equals(v.ownerUserId);
                /* hasPpt: match directo por Variante_Id__c, o legacy heredado por la variante default. */
                Boolean directMatch = variantIdsWithPpt.contains(r.Variante_Id__c);
                Boolean inheritsLegacy = legacyPptExists && (v.esDefault == true);
                v.hasPpt = directMatch || inheritsLegacy;
                out.add(v);
            }
            return out;
        } catch (Exception e) {
            System.debug('ERROR listVariants: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al listar variantes: ' + e.getMessage());
        }
    }

    /**
     * Lee la configuración JSON de una variante específica. Aplica filtros de visibilidad
     * (privadas solo para su creador).
     */
    @AuraEnabled
    public static String getVariant(String reportId, String varianteId) {
        try {
            if (String.isBlank(reportId) || String.isBlank(varianteId)) return null;
            String currentUserId = String.valueOf(UserInfo.getUserId()).substring(0, 18);
            List<Plantilla_Reporte__c> rows = [
                SELECT Id, Configuracion_JSON__c, Es_Publica__c, Owner_UserId__c
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId
                AND Variante_Id__c = :varianteId
                WITH SECURITY_ENFORCED
                LIMIT 1
            ];
            if (rows.isEmpty()) return null;
            Plantilla_Reporte__c r = rows[0];
            if (r.Es_Publica__c != true && !currentUserId.equals(r.Owner_UserId__c)) {
                throw new AuraHandledException('No tienes permiso para acceder a esta variante.');
            }
            return r.Configuracion_JSON__c;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR getVariant: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al leer variante: ' + e.getMessage());
        }
    }

    /**
     * Crea o actualiza una variante. Si varianteId está vacío genera uno nuevo (creación).
     * Si esDefault=true, desmarca las otras variantes default del reporte.
     * Devuelve el varianteId resultante (útil tras una creación).
     */
    @AuraEnabled
    public static String saveVariant(String reportId, String varianteId, String nombre,
                                     Boolean esDefault, Boolean esPublica, String jsonConfig) {
        try {
            if (String.isBlank(reportId)) throw new AuraHandledException('El ID del reporte es obligatorio.');
            if (String.isBlank(nombre)) throw new AuraHandledException('El nombre de la variante es obligatorio.');
            if (String.isBlank(jsonConfig)) throw new AuraHandledException('La configuración JSON es obligatoria.');

            String currentUserId = String.valueOf(UserInfo.getUserId()).substring(0, 18);
            String effVarianteId = String.isBlank(varianteId) ? generateVariantId() : varianteId;
            Boolean isCreate = String.isBlank(varianteId);

            /* Si esDefault=true, primero quitamos la marca del resto. */
            if (esDefault == true) {
                List<Plantilla_Reporte__c> defaults = [
                    SELECT Id, Es_Default__c
                    FROM Plantilla_Reporte__c
                    WHERE ID_del_Reporte__c = :reportId
                    AND Es_Default__c = true
                    AND Variante_Id__c != :effVarianteId
                    WITH SECURITY_ENFORCED
                ];
                if (!defaults.isEmpty()) {
                    for (Plantilla_Reporte__c d : defaults) d.Es_Default__c = false;
                    assertObjectUpdateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
                    SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, defaults);
                    update dec.getRecords();
                }
            }

            if (isCreate) {
                assertObjectCreateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
                Plantilla_Reporte__c row = new Plantilla_Reporte__c(
                    ID_del_Reporte__c = reportId,
                    Variante_Id__c = effVarianteId,
                    Variante_Nombre__c = nombre,
                    Es_Default__c = esDefault == true,
                    Es_Publica__c = esPublica == null ? true : esPublica,
                    Owner_UserId__c = currentUserId,
                    Configuracion_JSON__c = jsonConfig
                );
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.CREATABLE, new List<Plantilla_Reporte__c>{ row });
                insert dec.getRecords();
            } else {
                List<Plantilla_Reporte__c> rows = [
                    SELECT Id, Es_Publica__c, Owner_UserId__c
                    FROM Plantilla_Reporte__c
                    WHERE ID_del_Reporte__c = :reportId
                    AND Variante_Id__c = :effVarianteId
                    WITH SECURITY_ENFORCED
                    LIMIT 1
                ];
                if (rows.isEmpty()) throw new AuraHandledException('No se encontró la variante a actualizar.');
                Plantilla_Reporte__c row = rows[0];
                /* Privada => solo el creador puede modificarla. */
                if (row.Es_Publica__c != true && !currentUserId.equals(row.Owner_UserId__c)) {
                    throw new AuraHandledException('No tienes permiso para modificar esta variante privada.');
                }
                row.Variante_Nombre__c = nombre;
                row.Es_Default__c = esDefault == true;
                row.Es_Publica__c = esPublica == null ? true : esPublica;
                row.Configuracion_JSON__c = jsonConfig;
                assertObjectUpdateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, new List<Plantilla_Reporte__c>{ row });
                update dec.getRecords();
            }
            return effVarianteId;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR saveVariant: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al guardar variante: ' + e.getMessage());
        }
    }

    /** Elimina una variante. No deja al reporte sin variantes: rechaza la operación si es la única. */
    @AuraEnabled
    public static void deleteVariant(String reportId, String varianteId) {
        try {
            if (String.isBlank(reportId) || String.isBlank(varianteId)) {
                throw new AuraHandledException('reportId y varianteId son obligatorios.');
            }
            String currentUserId = String.valueOf(UserInfo.getUserId()).substring(0, 18);

            Integer total = [
                SELECT COUNT()
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId
                WITH SECURITY_ENFORCED
            ];
            if (total <= 1) {
                throw new AuraHandledException('No se puede eliminar la única variante existente. Crea otra antes de borrar esta.');
            }

            List<Plantilla_Reporte__c> rows = [
                SELECT Id, Es_Default__c, Es_Publica__c, Owner_UserId__c
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId
                AND Variante_Id__c = :varianteId
                WITH SECURITY_ENFORCED
                LIMIT 1
            ];
            if (rows.isEmpty()) throw new AuraHandledException('Variante no encontrada.');
            Plantilla_Reporte__c row = rows[0];
            if (row.Es_Publica__c != true && !currentUserId.equals(row.Owner_UserId__c)) {
                throw new AuraHandledException('No tienes permiso para eliminar esta variante privada.');
            }
            Boolean wasDefault = row.Es_Default__c == true;
            if (!Plantilla_Reporte__c.SObjectType.getDescribe().isDeletable()) {
                throw new AuraHandledException('No tienes permiso para eliminar plantillas.');
            }
            delete row;

            /* Si la borrada era default, promovemos cualquier otra a default automáticamente. */
            if (wasDefault) {
                List<Plantilla_Reporte__c> survivors = [
                    SELECT Id, Es_Default__c
                    FROM Plantilla_Reporte__c
                    WHERE ID_del_Reporte__c = :reportId
                    WITH SECURITY_ENFORCED
                    ORDER BY CreatedDate ASC
                    LIMIT 1
                ];
                if (!survivors.isEmpty()) {
                    survivors[0].Es_Default__c = true;
                    SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, survivors);
                    update dec.getRecords();
                }
            }
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR deleteVariant: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al eliminar variante: ' + e.getMessage());
        }
    }

    /** Duplica una variante existente con un nombre nuevo y la marca como privada del usuario actual por defecto. */
    @AuraEnabled
    public static String duplicateVariant(String reportId, String sourceVarianteId, String nuevoNombre) {
        try {
            if (String.isBlank(reportId) || String.isBlank(sourceVarianteId)) {
                throw new AuraHandledException('reportId y sourceVarianteId son obligatorios.');
            }
            if (String.isBlank(nuevoNombre)) throw new AuraHandledException('Nombre de la nueva variante obligatorio.');
            String currentUserId = String.valueOf(UserInfo.getUserId()).substring(0, 18);
            List<Plantilla_Reporte__c> rows = [
                SELECT Configuracion_JSON__c, Es_Publica__c, Owner_UserId__c
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId
                AND Variante_Id__c = :sourceVarianteId
                WITH SECURITY_ENFORCED
                LIMIT 1
            ];
            if (rows.isEmpty()) throw new AuraHandledException('Variante origen no encontrada.');
            Plantilla_Reporte__c src = rows[0];
            if (src.Es_Publica__c != true && !currentUserId.equals(src.Owner_UserId__c)) {
                throw new AuraHandledException('No puedes duplicar una variante privada de otro usuario.');
            }
            String newId = generateVariantId();
            assertObjectCreateable(Plantilla_Reporte__c.SObjectType, 'Plantilla de Reporte');
            Plantilla_Reporte__c clone = new Plantilla_Reporte__c(
                ID_del_Reporte__c = reportId,
                Variante_Id__c = newId,
                Variante_Nombre__c = nuevoNombre,
                Es_Default__c = false,
                Es_Publica__c = false,
                Owner_UserId__c = currentUserId,
                Configuracion_JSON__c = src.Configuracion_JSON__c
            );
            SObjectAccessDecision dec = Security.stripInaccessible(AccessType.CREATABLE, new List<Plantilla_Reporte__c>{ clone });
            insert dec.getRecords();
            return newId;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR duplicateVariant: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al duplicar variante: ' + e.getMessage());
        }
    }

    // ============================================================
    // HELPERS DE VARIANTES
    // ============================================================

    /** UUID-style id de variante (suficientemente único para nuestros volúmenes). */
    private static String generateVariantId() {
        Blob b = Crypto.generateAesKey(128);
        String hex = EncodingUtil.convertToHex(b);
        return 'v_' + hex.substring(0, 16);
    }

    /**
     * Busca la variante default de un reporte. Si no existe ninguna marcada como default
     * pero hay registros legacy (sin Variante_Id__c), promueve el más reciente a "Variante por defecto".
     * Devuelve la fila correspondiente o null si no hay nada para ese reporte.
     */
    private static Plantilla_Reporte__c findOrPromoteDefaultVariant(String reportId) {
        if (String.isBlank(reportId)) return null;
        List<Plantilla_Reporte__c> defaults = [
            SELECT Id, ID_del_Reporte__c, Variante_Id__c, Variante_Nombre__c, Es_Default__c,
                   Es_Publica__c, Owner_UserId__c, Configuracion_JSON__c
            FROM Plantilla_Reporte__c
            WHERE ID_del_Reporte__c = :reportId
            AND Es_Default__c = true
            WITH SECURITY_ENFORCED
            LIMIT 1
        ];
        if (!defaults.isEmpty()) return defaults[0];

        /* Migración: no hay default. Buscamos cualquier fila para promoverla. */
        List<Plantilla_Reporte__c> candidates = [
            SELECT Id, ID_del_Reporte__c, Variante_Id__c, Variante_Nombre__c, Es_Default__c,
                   Es_Publica__c, Owner_UserId__c, Configuracion_JSON__c
            FROM Plantilla_Reporte__c
            WHERE ID_del_Reporte__c = :reportId
            WITH SECURITY_ENFORCED
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        if (candidates.isEmpty()) return null;

        Plantilla_Reporte__c row = candidates[0];
        Boolean dirty = false;
        if (String.isBlank(row.Variante_Id__c)) { row.Variante_Id__c = generateVariantId(); dirty = true; }
        if (String.isBlank(row.Variante_Nombre__c)) { row.Variante_Nombre__c = 'Variante por defecto'; dirty = true; }
        if (row.Es_Default__c != true) { row.Es_Default__c = true; dirty = true; }
        if (row.Es_Publica__c == null) { row.Es_Publica__c = true; dirty = true; }
        if (String.isBlank(row.Owner_UserId__c)) {
            row.Owner_UserId__c = String.valueOf(UserInfo.getUserId()).substring(0, 18); dirty = true;
        }
        if (dirty && Plantilla_Reporte__c.SObjectType.getDescribe().isUpdateable()) {
            SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, new List<Plantilla_Reporte__c>{ row });
            update dec.getRecords();
        }
        return row;
    }

    // ============================================================
    // GUARDAR Y LEER CONFIGURACIÓN DE PPT
    // ------------------------------------------------------------
    // A partir de la migración a "PPT por variante del reporte":
    //   - Cada combinación (reportId, varianteId) tiene su propio Plantilla_Geneador_PPT__c.
    //   - varianteId nulo/blank se trata como 'default' (compatible con configs legacy).
    //   - Registros legacy (sin Variante_Id__c) se promueven automáticamente a la
    //     variante 'default' la primera vez que se accede / guarda, sin pérdida de datos.
    // ============================================================

    /* Constante semántica: id de la variante "por defecto" del reporte.
       Coincide con la variante default que ReporteKaufmannController crea al promover plantillas legacy. */
    private static final String PPT_DEFAULT_VARIANT_ID = 'default';

    private static String effectivePptVariantId(String varianteId) {
        return String.isBlank(varianteId) ? PPT_DEFAULT_VARIANT_ID : varianteId.trim();
    }

    /* Indica si una variante del reporte es la default (Es_Default__c=true) en Plantilla_Reporte__c.
       Si no se encuentra ninguna marcada como default y solo hay una fila para ese reporte,
       también devuelve true (caso single-variant, equivalente a default).
       Usado por findOrPromoteDefaultPpt para decidir si "heredar" la config PPT legacy. */
    private static Boolean isReporteVariantDefault(String reportId, String varianteId) {
        if (String.isBlank(reportId) || String.isBlank(varianteId)) return false;
        if (varianteId == PPT_DEFAULT_VARIANT_ID) return true;
        try {
            List<Plantilla_Reporte__c> defaults = [
                SELECT Variante_Id__c
                FROM Plantilla_Reporte__c
                WHERE ID_del_Reporte__c = :reportId AND Variante_Id__c = :varianteId AND Es_Default__c = true
                WITH SECURITY_ENFORCED
                LIMIT 1
            ];
            return !defaults.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /* Busca el registro PPT para (reportId, varianteId).
       NUEVO COMPORTAMIENTO (bug-fix p\u00e9rdida de datos):
       Esta funci\u00f3n es de SOLO LECTURA. NUNCA actualiza el campo Variante_Id__c
       del registro legacy. Eso evita el escenario en el que:
         1. El registro existe con Variante_Id__c='default' (heredado de pre-migraci\u00f3n).
         2. El usuario abre el PPT con un UUID real (porque seleccion\u00f3 una variante).
         3. Antes: se hac\u00eda UPDATE Variante_Id__c=UUID y, despu\u00e9s, cualquier acceso
            con varianteId=null o 'default' ya no encontraba nada \u2192 PPT "desaparecido".
       La promoci\u00f3n del Variante_Id__c (si procede) ocurre ahora SOLO en savePptConfig,
       y \u00fanicamente cuando el usuario ha guardado expl\u00edcitamente sobre ese contexto.
       La b\u00fasqueda devuelve el registro encontrado pero no muta nada en BD.
       Devuelve el registro o null si no existe nada. */
    private static Plantilla_Geneador_PPT__c findOrPromoteDefaultPpt(String reportId, String varianteId) {
        String vid = effectivePptVariantId(varianteId);
        /* 1) Coincidencia exacta por (reportId, varianteId). */
        List<Plantilla_Geneador_PPT__c> exact = [
            SELECT Id, Name, Variante_Id__c, Configuracion_PPT__c
            FROM Plantilla_Geneador_PPT__c
            WHERE Name = :reportId AND Variante_Id__c = :vid
            WITH SECURITY_ENFORCED
            LIMIT 1
        ];
        if (!exact.isEmpty()) return exact[0];

        /* 2) Herencia desde legacy: solo si la varianteId pedida es la default del reporte.
              Esto evita que una variante secundaria del reporte "robe" la config PPT legacy.
              Considera 2 tipos de "legacy":
                a) Registros sin Variante_Id__c (pre-migraci\u00f3n).
                b) Registros con Variante_Id__c='default' (creados antes de que el reporte tuviera
                   variante definida; t\u00edpico cuando se accede al PPT antes de guardar el reporte).
              READ-ONLY: solo devolvemos el registro encontrado; NO mutamos su Variante_Id__c.
              La promoci\u00f3n del campo se hace al guardar (savePptConfig). */
        Boolean canInheritLegacy = (vid == PPT_DEFAULT_VARIANT_ID) || isReporteVariantDefault(reportId, vid);
        if (canInheritLegacy) {
            List<Plantilla_Geneador_PPT__c> legacy = [
                SELECT Id, Name, Variante_Id__c, Configuracion_PPT__c
                FROM Plantilla_Geneador_PPT__c
                WHERE Name = :reportId AND (Variante_Id__c = null OR Variante_Id__c = :PPT_DEFAULT_VARIANT_ID)
                WITH SECURITY_ENFORCED
                ORDER BY LastModifiedDate DESC
                LIMIT 1
            ];
            if (!legacy.isEmpty()) {
                return legacy[0];
            }
        }
        return null;
    }

    @AuraEnabled
    public static void savePptConfig(String reportId, String varianteId, String jsonConfig) {
        try {
            if (String.isBlank(reportId)) throw new AuraHandledException('El ID del reporte es obligatorio.');
            String vid = effectivePptVariantId(varianteId);

            Plantilla_Geneador_PPT__c existing = findOrPromoteDefaultPpt(reportId, vid);

            /* Normalizamos el Variante_Id__c del existente para comparar:
               - null se trata como 'default' (registro legacy sin variante).
               - Cualquier otro valor se compara tal cual.
               Si el existente coincide con vid, UPDATE del Configuracion (caso normal).
               Si NO coincide (caso: existente='default' o null, vid=UUID real), insertamos
               un NUEVO registro asociado al UUID, dejando el legacy intacto. As\u00ed se evita
               la p\u00e9rdida de datos para futuras lecturas con varianteId=null/'default'. */
            String existingVid = (existing == null) ? null : effectivePptVariantId(existing.Variante_Id__c);
            Boolean matches = (existing != null) && (existingVid == vid);

            if (matches) {
                assertObjectUpdateable(Plantilla_Geneador_PPT__c.SObjectType, 'Plantilla de PPT');
                existing.Configuracion_PPT__c = jsonConfig;
                /* Promovemos el Variante_Id__c solo si est\u00e1 en blanco (registro legacy
                   sin variante) y vid='default'. As\u00ed pasa a quedar expl\u00edcitamente como 'default'.
                   Si ya tiene un valor (cualquiera), no lo tocamos. */
                if (String.isBlank(existing.Variante_Id__c) && vid == PPT_DEFAULT_VARIANT_ID) {
                    existing.Variante_Id__c = vid;
                }
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, new List<Plantilla_Geneador_PPT__c>{ existing });
                update dec.getRecords();
            } else {
                /* O bien no exist\u00eda registro alguno, o el \u00fanico match era un legacy con otra
                   varianteId (caso degradado de fork). En ambos casos INSERTAMOS. */
                assertObjectCreateable(Plantilla_Geneador_PPT__c.SObjectType, 'Plantilla de PPT');
                Plantilla_Geneador_PPT__c newTemplate = new Plantilla_Geneador_PPT__c(
                    Name = reportId,
                    Variante_Id__c = vid,
                    Configuracion_PPT__c = jsonConfig
                );
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.CREATABLE, new List<Plantilla_Geneador_PPT__c>{ newTemplate });
                insert dec.getRecords();
            }
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR savePptConfig: ' + e.getMessage() + ' \n L\u00ednea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al guardar config PPT: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String getPptConfig(String reportId, String varianteId) {
        try {
            if (String.isBlank(reportId)) return null;
            Plantilla_Geneador_PPT__c row = findOrPromoteDefaultPpt(reportId, varianteId);
            return row == null ? null : row.Configuracion_PPT__c;
        } catch (Exception e) {
            System.debug('ERROR getPptConfig: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener config PPT: ' + e.getMessage());
        }
    }

    // ============================================================
    // GUARDAR EXCEL EN SALESFORCE
    // ============================================================
    @AuraEnabled
    public static Id saveExcelToSalesforce(String base64Data, String fileName, Id recordId) {
        try {
            if (String.isBlank(base64Data)) throw new AuraHandledException('El contenido del archivo está vacío.');
            if (String.isBlank(fileName)) fileName = 'Reporte';

            if (!ContentVersion.SObjectType.getDescribe().isCreateable()) {
                throw new AuraHandledException('No tienes permiso para subir archivos.');
            }

            ContentVersion cv = new ContentVersion();
            cv.VersionData = EncodingUtil.base64Decode(base64Data);
            cv.Title = fileName;
            cv.PathOnClient = fileName + '.xlsx';
            insert cv;

            cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id WITH SECURITY_ENFORCED];

            if (recordId != null) {
                if (!ContentDocumentLink.SObjectType.getDescribe().isCreateable()) {
                    /* No bloqueamos el guardado del archivo, pero advertimos al usuario que no se vinculó. */
                    System.debug(LoggingLevel.WARN, 'No se pudo crear ContentDocumentLink: usuario sin permisos.');
                    return cv.ContentDocumentId;
                }
                ContentDocumentLink cdl = new ContentDocumentLink(
                    ContentDocumentId = cv.ContentDocumentId,
                    LinkedEntityId = recordId,
                    ShareType = 'V',
                    Visibility = 'InternalUsers'
                );
                insert cdl;
            }
            return cv.ContentDocumentId;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR saveExcelToSalesforce: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al guardar Excel: ' + e.getMessage());
        }
    }

    // ============================================================
    // OBTENER DISEÑOS DE PPT DESDE CUSTOM OBJECT
    // ============================================================
    @AuraEnabled(cacheable=true)
    public static List<Plantillas_Power_Point__c> getPptDesigns() {
        try {
            return [
                SELECT Id, Name, Activo__c, Color_Primario__c, Color_Secundario__c,
                       Fuente_Corporativa__c, Configuracion_JSON__c, Fondo_Diapositiva_Id__c,
                       LastModifiedDate
                FROM Plantillas_Power_Point__c
                WHERE Activo__c = true
                WITH SECURITY_ENFORCED
                ORDER BY Name ASC
            ];
        } catch (Exception e) {
            System.debug('ERROR getPptDesigns: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener diseños: ' + e.getMessage());
        }
    }

    // ============================================================
    // OBTENER EXCEL GUARDADO PARA EL PPT
    // ============================================================
    @AuraEnabled
    public static String getExcelFileBase64(Id documentId) {
        try {
            if (documentId == null) throw new AuraHandledException('El Id del archivo es obligatorio.');
            List<ContentVersion> cvs = [
                SELECT VersionData, ContentSize
                FROM ContentVersion
                WHERE ContentDocumentId = :documentId
                WITH SECURITY_ENFORCED
                ORDER BY IsLatest DESC
                LIMIT 1
            ];
            if (cvs.isEmpty()) throw new AuraHandledException('El archivo solicitado no existe o no tienes acceso.');
            ContentVersion cv = cvs[0];
            if (cv.ContentSize != null && cv.ContentSize > MAX_FILE_SIZE_BYTES) {
                throw new AuraHandledException('El archivo supera el límite permitido (' + (MAX_FILE_SIZE_BYTES / 1024 / 1024) + ' MB). Reduce el tamaño antes de procesarlo.');
            }
            return EncodingUtil.base64Encode(cv.VersionData);
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR getExcelFileBase64: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener Excel: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static Map<Id, String> getBase64Images(List<Id> documentIds) {
        Map<Id, String> base64Map = new Map<Id, String>();
        try {
            if (documentIds == null || documentIds.isEmpty()) return base64Map;
            if (documentIds.size() > MAX_IMAGES_PER_CALL) {
                throw new AuraHandledException('Demasiadas imágenes solicitadas a la vez (máximo ' + MAX_IMAGES_PER_CALL + ').');
            }
            List<ContentVersion> versions = [
                SELECT ContentDocumentId, VersionData, ContentSize
                FROM ContentVersion
                WHERE ContentDocumentId IN :documentIds
                AND IsLatest = true
                WITH SECURITY_ENFORCED
            ];
            for (ContentVersion cv : versions) {
                if (cv.ContentSize != null && cv.ContentSize > MAX_FILE_SIZE_BYTES) {
                    /* No se sube la imagen pesada a memoria; el cliente cae a fallback (sin fondo). */
                    System.debug(LoggingLevel.WARN, 'Imagen omitida por tamaño: ' + cv.ContentDocumentId);
                    continue;
                }
                base64Map.put(cv.ContentDocumentId, EncodingUtil.base64Encode(cv.VersionData));
            }
            return base64Map;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR getBase64Images: ' + e.getMessage() + ' \n Línea: ' + e.getLineNumber());
            throw new AuraHandledException('Error al obtener imágenes: ' + e.getMessage());
        }
    }
}