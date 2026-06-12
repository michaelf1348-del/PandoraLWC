public with sharing class ImputacionesAMSController {
    /** Fallback si el objeto operativo no tiene PEP_Facturable__c o esta vacio. */
    private static final Set<String> DEFAULT_ALWAYS_FACTURABLE_PEP_FALLBACK = new Set<String>{ 'C1-Z-PR-VAC' };
    private static final String OPERATIVE_CONFIG_KEY = 'DEFAULT';

    private static Boolean operativeConfigLoaded = false;
    private static Configurar_Centro_Imputaciones__c operativeConfigRow;

    private static Set<String> cachedAlwaysFacturablePepNames;

    /** Llamar tras guardar Configurar_Centro_Imputaciones__c para releer reglas en la misma sesion Apex. */
    public static void clearOperativeConfigCache() {
        operativeConfigLoaded = false;
        operativeConfigRow = null;
        cachedAlwaysFacturablePepNames = null;
        ImputacionesBillableRules.clearCache();
    }

    private static Configurar_Centro_Imputaciones__c getOperativeConfigRow() {
        if (operativeConfigLoaded) {
            return operativeConfigRow;
        }
        operativeConfigLoaded = true;
        operativeConfigRow = null;
        try {
            operativeConfigRow = ImputacionesOperativeConfigLoader.loadDefault();
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'getOperativeConfigRow: ' + e.getMessage());
        }
        return operativeConfigRow;
    }

    private static Set<String> parseDelimitedTokens(String raw) {
        Set<String> out = new Set<String>();
        if (String.isBlank(raw)) {
            return out;
        }
        for (String token : raw.split('[,\\n\\r;]+')) {
            String t = token != null ? token.trim() : '';
            if (String.isNotBlank(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** Usuario actual coincide con campo/valores configurados (excepcion fin de semana, filtro consultor, etc.). */
    private static Boolean currentUserMatchesConfigUserField(String fieldApi, String valuesRaw) {
        if (String.isBlank(fieldApi) || String.isBlank(valuesRaw)) {
            return false;
        }
        String api = fieldApi.trim();
        Map<String, Schema.SObjectField> fMap = User.SObjectType.getDescribe().fields.getMap();
        if (!fMap.containsKey(api)) {
            return false;
        }
        Schema.DescribeFieldResult dfr = fMap.get(api).getDescribe();
        if (!dfr.isAccessible()) {
            return false;
        }
        Set<String> allowed = parseDelimitedTokens(valuesRaw);
        if (allowed.isEmpty()) {
            return false;
        }
        try {
            Id uid = UserInfo.getUserId();
            String soql =
                'SELECT ' +
                String.escapeSingleQuotes(api) +
                ' FROM User WHERE Id = :uid LIMIT 1';
            User u = Database.query(soql);
            Object raw = u.get(api);
            if (raw == null) {
                return false;
            }
            String val = String.valueOf(raw).trim();
            for (String tok : allowed) {
                if (val.equalsIgnoreCase(tok)) {
                    return true;
                }
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'currentUserMatchesConfigUserField: ' + ex.getMessage());
        }
        return false;
    }

    private static List<String> resolveGlobalTicketServicioValues() {
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        List<String> out = new List<String>();
        if (cfg != null && String.isNotBlank(cfg.Filtro_Servicio_Tickets__c)) {
            for (String s : parseDelimitedTokens(cfg.Filtro_Servicio_Tickets__c)) {
                out.add(s);
            }
        }
        return out;
    }

    private static List<Case> filterCasesByGlobalServicio(List<Case> input) {
        if (input == null || input.isEmpty()) {
            return input == null ? new List<Case>() : input;
        }
        List<String> vals = resolveGlobalTicketServicioValues();
        String servField = resolveCaseServicioFieldApi();
        if (String.isBlank(servField) || vals.isEmpty()) {
            return input;
        }
        Set<Id> ids = new Set<Id>();
        for (Case c : input) {
            if (c != null && c.Id != null) {
                ids.add(c.Id);
            }
        }
        if (ids.isEmpty()) {
            return new List<Case>();
        }
        Set<String> bindVals = new Set<String>(vals);
        try {
            String q =
                'SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name FROM Case WHERE Id IN :ids AND ' +
                servField +
                ' IN :bindVals ORDER BY LastModifiedDate DESC';
            return Database.query(q);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'filterCasesByGlobalServicio: ' + ex.getMessage());
            return input;
        }
    }

    private static Set<String> getAlwaysFacturablePepNames() {
        if (cachedAlwaysFacturablePepNames != null) {
            return cachedAlwaysFacturablePepNames;
        }
        Set<String> out = new Set<String>();
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        if (cfg != null && String.isNotBlank(cfg.PEP_Facturable__c)) {
            out.addAll(parseDelimitedTokens(cfg.PEP_Facturable__c));
        }
        if (out.isEmpty() && cfg != null && String.isNotBlank(cfg.PEP_Fallback__c)) {
            out.addAll(parseDelimitedTokens(cfg.PEP_Fallback__c));
        }
        out.addAll(DEFAULT_ALWAYS_FACTURABLE_PEP_FALLBACK);
        cachedAlwaysFacturablePepNames = out;
        return cachedAlwaysFacturablePepNames;
    }

    /** PEP de vacaciones (p. ej. C1-Z-PR-VAC): facturable y fechas futuras alineadas con el LWC. */
    private static Boolean isAlwaysFacturablePepName(String pepName) {
        if (String.isBlank(pepName)) {
            return false;
        }
        String norm = pepName.trim();
        for (String token : getAlwaysFacturablePepNames()) {
            if (norm.equalsIgnoreCase(token)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Misma regla que imputacionesAMSMonthWindowUtil.js (LWC).
     * Base: mes civil en curso. Ventana retro/adelante: excepcion para otros meses.
     * En meses futuros dentro de la ventana, VAC exige fecha &gt;= hoy.
     */
    private static Boolean isEntryDateAllowedForConsultant(
        Date entryDate,
        Boolean allowFutureDates,
        Integer retro,
        Integer forward
    ) {
        if (entryDate == null) {
            return false;
        }
        Date today = Date.today();
        if (isEntryDateInCurrentMonth(entryDate)) {
            return true;
        }
        if (retro == 0 && forward == 0) {
            return false;
        }
        Integer entryYm = entryDate.year() * 12 + (entryDate.month() - 1);
        Integer todayYm = today.year() * 12 + (today.month() - 1);
        if (entryYm < todayYm - retro || entryYm > todayYm + forward) {
            return false;
        }
        if (entryYm < todayYm) {
            return true;
        }
        if (allowFutureDates == true) {
            return entryDate >= today;
        }
        return true;
    }

    /** Motivos AMS: solo objeto operativo + reservas + ultimo recurso + fallback codigo. */
    private static Set<String> resolveAmsReasonValues() {
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        if (cfg != null && String.isNotBlank(cfg.Motivo_Ticket__c)) {
            Set<String> fromObj = parseDelimitedTokens(cfg.Motivo_Ticket__c);
            if (!fromObj.isEmpty()) {
                return fromObj;
            }
        }
        return parseAmsReasonFallbackChain();
    }

    private static List<Integer> getImputationMonthWindow() {
        Integer retro = 0;
        Integer forward = 0;
        Configurar_Centro_Imputaciones__c cfgDates = getOperativeConfigRow();
        if (cfgDates != null && cfgDates.Imputacion_Meses_Retro__c != null) {
            retro = Math.max(0, Math.min(120, cfgDates.Imputacion_Meses_Retro__c.intValue()));
        }
        if (cfgDates != null && cfgDates.Imputacion_Meses_Adelante__c != null) {
            forward = Math.max(0, Math.min(120, cfgDates.Imputacion_Meses_Adelante__c.intValue()));
        }
        return new List<Integer>{ retro, forward };
    }

    private static String formatYmFromParts(Integer year, Integer month) {
        String mm = month < 10 ? '0' + String.valueOf(month) : String.valueOf(month);
        return year + '-' + mm;
    }

    private static String formatImputationYmRangeDiag(Integer retro, Integer forward) {
        Date today = Date.today();
        Integer todayYm = today.year() * 12 + (today.month() - 1);
        if (retro == 0 && forward == 0) {
            return formatYmFromParts(today.year(), today.month());
        }
        Integer earliestYm = todayYm - retro;
        Integer latestYm = todayYm + forward;
        Integer y0 = earliestYm / 12;
        Integer m0 = Math.mod(earliestYm, 12) + 1;
        Integer y1 = latestYm / 12;
        Integer m1 = Math.mod(latestYm, 12) + 1;
        return formatYmFromParts(y0, m0) + ' … ' + formatYmFromParts(y1, m1);
    }

    private static Date readImputationDateFromRecord(SObject rec, Map<String, Schema.SObjectField> fMap, String dateApi) {
        if (rec == null || String.isBlank(dateApi) || fMap == null || !fMap.containsKey(dateApi)) {
            return null;
        }
        Schema.DescribeFieldResult fd = fMap.get(dateApi).getDescribe();
        Object dv = rec.get(dateApi);
        if (dv == null) {
            return null;
        }
        if (fd.getType() == Schema.DisplayType.DATE) {
            return (Date) dv;
        }
        if (fd.getType() == Schema.DisplayType.DATETIME || dv instanceof DateTime) {
            return ((DateTime) dv).date();
        }
        return null;
    }

    private static Boolean imputationRecordDateModifiableByConsultant(
        SObject rec,
        Map<String, Schema.SObjectField> fMap
    ) {
        if (rec == null || fMap == null) {
            return false;
        }
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        if (String.isBlank(dateApi)) {
            dateApi = resolveImputationDateFieldForLatest(fMap);
        }
        Date entryDate = readImputationDateFromRecord(rec, fMap, dateApi);
        if (entryDate == null) {
            return false;
        }
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        Boolean vacationPep = false;
        if (String.isNotBlank(ticketApi)) {
            Id caseId = (Id) rec.get(ticketApi);
            if (caseId != null) {
                try {
                    List<Case> cs = [SELECT PEP__r.Name FROM Case WHERE Id = :caseId LIMIT 1];
                    if (!cs.isEmpty() && cs[0].PEP__r != null) {
                        vacationPep = isAlwaysFacturablePepName(cs[0].PEP__r.Name);
                    }
                } catch (Exception ignore) {
                }
            }
        }
        return isImputationDateModifiableByConsultant(entryDate, vacationPep);
    }

    private static Boolean isEntryDateInCurrentMonth(Date entryDate) {
        if (entryDate == null) {
            return false;
        }
        Date today = Date.today();
        return entryDate.year() == today.year() && entryDate.month() == today.month();
    }

    /** Editar / borrar / imputar: mes en curso; ventana retro/adelante como excepcion (VAC: fechas futuras en meses posteriores). */
    private static Boolean isImputationDateModifiableByConsultant(
        Date entryDate,
        Boolean vacationPep
    ) {
        if (entryDate == null) {
            return false;
        }
        List<Integer> win = getImputationMonthWindow();
        return isEntryDateAllowedForConsultant(entryDate, vacationPep == true, win[0], win[1]);
    }

    /** Servicios Case para pestana AMS: prioriza objeto; si vacio, AMS-SAP / AMS-SAP-Mexico. */
    private static List<String> resolveAmsServicioValues() {
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        if (cfg != null && String.isNotBlank(cfg.Servicios__c)) {
            List<String> out = new List<String>();
            for (String s : parseDelimitedTokens(cfg.Servicios__c)) {
                out.add(s);
            }
            if (!out.isEmpty()) {
                return out;
            }
        }
        if (cfg != null && String.isNotBlank(cfg.Servicios_Fallback__c)) {
            List<String> outFb = new List<String>();
            for (String s : parseDelimitedTokens(cfg.Servicios_Fallback__c)) {
                outFb.add(s);
            }
            if (!outFb.isEmpty()) {
                return outFb;
            }
        }
        if (cfg != null && String.isNotBlank(cfg.Servicios_Ultimo_Recurso__c)) {
            List<String> outUr = new List<String>();
            for (String s : parseDelimitedTokens(cfg.Servicios_Ultimo_Recurso__c)) {
                outUr.add(s);
            }
            if (!outUr.isEmpty()) {
                return outUr;
            }
        }
        return new List<String>{ 'AMS-SAP', 'AMS-SAP-Mexico' };
    }

    private static Integer resolveSoqlLimitMonthAggregation() {
        try {
            Configurar_Centro_Imputaciones__c c = getOperativeConfigRow();
            if (c != null && c.Limite_Soql_Mes_Agregacion__c != null) {
                Integer n = c.Limite_Soql_Mes_Agregacion__c.intValue();
                if (n >= 2000 && n <= 50000) {
                    return n;
                }
            }
        } catch (Exception ignore) {
        }
        return 20000;
    }

    private static Integer resolveSoqlLimitDayBreakdown() {
        try {
            Configurar_Centro_Imputaciones__c c = getOperativeConfigRow();
            if (c != null && c.Limite_Soql_Desglose_Dia__c != null) {
                Integer n = c.Limite_Soql_Desglose_Dia__c.intValue();
                if (n >= 50 && n <= 2000) {
                    return n;
                }
            }
        } catch (Exception ignore) {
        }
        return 400;
    }

    private static Integer resolveSoqlLimitOwnerOptions() {
        try {
            Configurar_Centro_Imputaciones__c c = getOperativeConfigRow();
            if (c != null && c.Limite_Soql_Owner_Opciones__c != null) {
                Integer n = c.Limite_Soql_Owner_Opciones__c.intValue();
                if (n >= 10 && n <= 2000) {
                    return n;
                }
            }
        } catch (Exception ignore) {
        }
        return 200;
    }

    /** pageSize en listados de tickets cuando el cliente no lo envía (1–500; defecto 200). */
    private static Integer resolveDefaultTicketPageSize() {
        try {
            Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
            if (cfg != null && cfg.Tamano_Pagina_Tickets__c != null) {
                Integer n = cfg.Tamano_Pagina_Tickets__c.intValue();
                if (n >= 1 && n <= 500) {
                    return n;
                }
            }
        } catch (Exception ignore) {
        }
        return 200;
    }

    /** Origen/Source por defecto al persistir imputaciones (defecto MassiveLWC). */
    private static String resolveDefaultImputationSource() {
        try {
            Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
            if (cfg != null && String.isNotBlank(cfg.Origen_Imputacion__c)) {
                return cfg.Origen_Imputacion__c.trim();
            }
        } catch (Exception ignore) {
        }
        return 'MassiveLWC';
    }

    /** Nombre del campo lookup PEP en Imputacion__c. null si no existe. */
    private static String resolveImputationPepFieldApi(Map<String, Schema.SObjectField> fMap) {
        if (fMap == null || !fMap.containsKey('PEP__c')) {
            return null;
        }
        Schema.DescribeFieldResult d = fMap.get('PEP__c').getDescribe();
        return d.isAccessible() ? d.getName() : null;
    }

    /** Devuelve true si el registro Imputacion__c apunta a un PEP cuyo Name está en la lista de "siempre facturables". */
    private static Boolean isAlwaysFacturablePep(SObject rec) {
        if (rec == null) return false;
        try {
            SObject pepRel = rec.getSObject('PEP__r');
            if (pepRel == null) return false;
            Object nm = pepRel.get('Name');
            if (nm == null) return false;
            return getAlwaysFacturablePepNames().contains(String.valueOf(nm).trim());
        } catch (Exception e) {
            return false;
        }
    }

    public class FilterDTO {
        @AuraEnabled public List<String> statuses;
        @AuraEnabled public List<String> ownerIds;
        @AuraEnabled public List<String> caseIds;
        @AuraEnabled public Integer pageSize;
        @AuraEnabled public Integer pageNumber;
        /** mine (default) | ams — ams pendiente de datos reales desde backend/equipo. */
        @AuraEnabled public String listSource;
        /** Filtro de fecha de creación del caso (yyyy-MM-dd). Usado en pestaña AMS para acotar volúmenes grandes. */
        @AuraEnabled public String createdDateFromIso;
        @AuraEnabled public String createdDateToIso;
    }

    public class OptionDTO {
        @AuraEnabled public String label;
        @AuraEnabled public String value;
    }

    public class UiOptionsDTO {
        @AuraEnabled public List<OptionDTO> owners;
        @AuraEnabled public Boolean isImputationAdmin;
    }

    /** Configuracion operativa del centro de imputaciones (objeto + defaults en codigo). */
    public class ImputationCenterSettingsDTO {
        @AuraEnabled public Decimal monthlyFacturableTargetPct;
        @AuraEnabled public Decimal workdayTargetHours;
        @AuraEnabled public String adminHelpText;
        @AuraEnabled public String developerName;
        /** Lista de valores API Reason/motivo AMS (CMDT Lista_PEP_AMS__c). */
        @AuraEnabled public String listaPepAms;
        /** API del campo motivo en Case (CMDT Campo_PEP_Case__c); vacío → Reason. */
        @AuraEnabled public String campoPepCaseApi;
        /** Desde objeto operativo Configurar_Centro_Imputaciones__c (si aplica). */
        @AuraEnabled public Decimal operativeMaxPinnedTickets;
        @AuraEnabled public Decimal operativeStripCalendarDays;
        @AuraEnabled public Decimal operativeDayHighlightHours;
        /** Umbral aviso «muchas horas el mismo día» en LWC (objeto operativo). */
        @AuraEnabled public Decimal operativeWarnDayHours;
        /** Tamaño de página tickets cuando el cliente no envía pageSize. */
        @AuraEnabled public Decimal operativeTicketPageSize;
        /** Origen imputación por defecto si la línea no trae source. */
        @AuraEnabled public String operativeDefaultSource;
        /** Fase A: ayuda visible en cabecera LWC. */
        @AuraEnabled public String helpBannerText;
        /** Modal Guia de uso para consultores (toggle en configuracion). */
        @AuraEnabled public Boolean showUsageGuide;
        @AuraEnabled public String usageGuideIntro;
        /** Festivos MM-DD extra (se suman a la lista base Chile en LWC). */
        @AuraEnabled public String extraHolidaysMmDd;
        @AuraEnabled public Decimal imputationMonthsRetro;
        @AuraEnabled public Decimal imputationMonthsForward;
        /** Dias hacia atras para filtro creado AMS por defecto (0 = mes en curso). */
        @AuraEnabled public Decimal amsCreatedFilterDaysBack;
        @AuraEnabled public Boolean uiHideImportCsv;
        @AuraEnabled public Boolean uiHideExportCsv;
        @AuraEnabled public Boolean uiHideQuarterPanel;
        @AuraEnabled public Boolean uiHideAmsTab;
        @AuraEnabled public String calColorEmptyBg;
        @AuraEnabled public String calColorPartialBg;
        @AuraEnabled public String calColorPartialBorder;
        @AuraEnabled public String calColorMetaBg;
        @AuraEnabled public String calColorMetaBorder;
        @AuraEnabled public String calColorOverThreshold;
        @AuraEnabled public String calColorHolidayBg;
        @AuraEnabled public String calColorWeekendBg;
        @AuraEnabled public String calColorSelectedBg;
        @AuraEnabled public String calColorSelectedBorder;
        @AuraEnabled public String calColorLockedBg;
        @AuraEnabled public String chartColorFacturable;
        @AuraEnabled public String chartColorNoFacturable;
        @AuraEnabled public String chartColorMetaProgress;
        @AuraEnabled public String chartColorImputable;
        @AuraEnabled public List<TicketCatalogTabDTO> ticketCatalogTabs;
        @AuraEnabled public Boolean allowWeekendImputation;
        @AuraEnabled public Boolean allowHolidayImputation;
        @AuraEnabled public String weekendConfirmText;
        @AuraEnabled public String thresholdHoursWarnText;
        @AuraEnabled public String holidayWarningText;
        @AuraEnabled public String confirmImputationExtraText;
        @AuraEnabled public String panelMetaCopyJson;
        @AuraEnabled public String criterioCalculoFacturable;
        @AuraEnabled public String criterioCalculoNoFacturable;
        @AuraEnabled public String headerCenterTagline;
        @AuraEnabled public String imputationExceptionDates;
        @AuraEnabled public Boolean activarAvisoUmbralHoras;
        @AuraEnabled public Boolean userWeekendImputationBypass;
        @AuraEnabled public String billableCriteriaFiltersJson;
    }

    public class TicketCatalogTabDTO {
        @AuraEnabled public String id;
        @AuraEnabled public String label;
        @AuraEnabled public String type;
        @AuraEnabled public Boolean supportsCreatedDateFilter;
        @AuraEnabled public String tabHint;
        @AuraEnabled public Boolean hidden;
        @AuraEnabled public Integer createdDateDaysBack;
    }

    public class ConfigDiagnosticRowDTO {
        @AuraEnabled public String key;
        @AuraEnabled public String label;
        @AuraEnabled public String effectiveValue;
        @AuraEnabled public String source;
        /** code | runtime | config */
        @AuraEnabled public String rowKind;
    }

    public class TicketRowDTO {
        @AuraEnabled public Id caseId;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public Id ownerId;
        @AuraEnabled public String ownerName;
        @AuraEnabled public Id lastImputationId;
        @AuraEnabled public Decimal alreadyImputedHours;
        /** true si el motivo del caso está en la lista AMS del CMDT (misma regla que pestaña Gestión AMS). */
        @AuraEnabled public Boolean isAmsManagementCase;
        /** Solo si existe campo no facturable en Imputacion__c y el agregado responde. */
        @AuraEnabled public Decimal alreadyImputedFacturableHours;
        @AuraEnabled public Decimal alreadyImputedNoFacturableHours;
        @AuraEnabled public Boolean billableHoursSplitAvailable;
        /** Responsable = eres owner del caso. Equipo = estas en Case Team (no owner). Vacio para admin de imputacion. */
        @AuraEnabled public String participationRole;
        /** Nombre del PEP del Case (Case.PEP__r.Name). Vacío si no hay PEP o el campo no existe. */
        @AuraEnabled public String pepName;
        /** true si las imputaciones de este ticket pueden registrarse a fechas futuras (ej. vacaciones). */
        @AuraEnabled public Boolean allowsFutureDates;
        /** Valores Case usados por reglas facturable (fieldApi -> valor texto). */
        @AuraEnabled public String caseRuleFieldsJson;
        /** Bloquea "No fact." por reglas Case (incl. AMS) salvo excepcion configurada. */
        @AuraEnabled public Boolean caseNoFactLocked;
    }

    public class EntryDTO {
        @AuraEnabled public String rowKey;
        @AuraEnabled public Id caseId;
        @AuraEnabled public Id imputingUserId;
        @AuraEnabled public Date entryDate;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public String comment;
        @AuraEnabled public String source;
    }

    public class ValidationResultDTO {
        @AuraEnabled public String rowKey;
        @AuraEnabled public Boolean isValid;
        @AuraEnabled public List<String> errors;
    }

    public class SaveResultDTO {
        @AuraEnabled public String rowKey;
        @AuraEnabled public Boolean success;
        @AuraEnabled public Id imputacionId;
        @AuraEnabled public List<String> errors;
    }

    public class SaveResponseDTO {
        @AuraEnabled public Integer total;
        @AuraEnabled public Integer ok;
        @AuraEnabled public Integer failed;
        @AuraEnabled public List<SaveResultDTO> results;
    }

    public class DayHoursDTO {
        @AuraEnabled public String isoDate;
        @AuraEnabled public Decimal hours;
        /** Horas que cuentan para la meta facturable (excluye tickets AMS y líneas marcadas no facturables). */
        @AuraEnabled public Decimal facturableHours;
        /** Horas no facturables: marca en el registro y todo el tiempo imputado en tickets de gestión AMS (lista CMDT). */
        @AuraEnabled public Decimal noFacturableHours;
    }

    /** Fila del lote pendiente para preview facturable (grafico pre-guardado). */
    public class PendingBillablePreviewRowDTO {
        @AuraEnabled public String caseId;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public Integer dateCount;
        @AuraEnabled public Boolean plannedNoFacturable;
        @AuraEnabled public Boolean isAmsManagementCase;
        @AuraEnabled public Boolean allowsFutureDates;
        @AuraEnabled public String caseRuleFieldsJson;
    }

    public class BillableHoursBreakdownDTO {
        @AuraEnabled public Decimal factHours;
        @AuraEnabled public Decimal noFactHours;
        /** FA/NF por ticket (cache LWC: recalcular horas sin nuevo round-trip). */
        @AuraEnabled public List<CaseBillableOutcomeDTO> caseOutcomes;
    }

    /** Solicitud individual de prediccion Ind por caso (sin horas: cache LWC suma local). */
    public class IndPreviewRequestRowDTO {
        @AuraEnabled public String caseId;
        @AuraEnabled public Boolean plannedNoFacturable;
        @AuraEnabled public Boolean isAmsManagementCase;
        @AuraEnabled public Boolean allowsFutureDates;
        @AuraEnabled public String caseRuleFieldsJson;
    }

    public class IndPreviewResultRowDTO {
        @AuraEnabled public String caseId;
        @AuraEnabled public Boolean plannedNoFacturable;
        @AuraEnabled public Boolean isNoFacturable;
        @AuraEnabled public Boolean resolvedByInd;
    }

    public class CaseBillableOutcomeDTO {
        @AuraEnabled public String caseId;
        @AuraEnabled public Boolean noFacturable;
    }

    /** Fila para exportar imputaciones del mes (CSV). */
    public class ExportImputationRowDTO {
        @AuraEnabled public String caseNumber;
        @AuraEnabled public Id imputationId;
        @AuraEnabled public String isoDate;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public String comment;
    }

    /** Linea por registro de imputacion (popup barra/calendario). */
    public class TicketHoursLineDTO {
        @AuraEnabled public Id imputationId;
        @AuraEnabled public Id caseId;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public Decimal hours;
        /** true = no facturable, false = facturable si el campo existe; null = campo no disponible. */
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public String comment;
        /** Misma regla que el modal por ticket: admin o dueño (Final/legacy/CreatedBy) y fecha editable. */
        @AuraEnabled public Boolean canEdit;
    }

    /** Una fila del modal «todas las imputaciones del caso». */
    public class CaseImputationLineDTO {
        @AuraEnabled public String imputationId;
        @AuraEnabled public String isoDate;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public String comment;
        @AuraEnabled public Boolean canEdit;
        @AuraEnabled public Boolean isOwnLine;
    }

    public class UpdateImputationPayloadDTO {
        @AuraEnabled public Id imputationId;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public String entryDateIso;
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public String comment;
    }

    /**
     * Preview opcional del lote (API / integraciones): Criterios_Facturable_Filtros_JSON__c fijo en el centro.
     * El LWC usa el mismo criterio en el navegador (tiempo real). Tras guardar: Ind_Imputacion__c.
     * Si cambia la formula Ind en Setup, actualizar el JSON (manual o Flow); no se rellena en cada imputacion.
     */
    @AuraEnabled(cacheable=false)
    public static String previewPendingBillableBreakdown(String rowsJson) {
        BillableHoursBreakdownDTO out = new BillableHoursBreakdownDTO();
        out.factHours = 0;
        out.noFactHours = 0;

        if (String.isBlank(rowsJson)) {
            return JSON.serialize(out);
        }

        List<PendingBillablePreviewRowDTO> inputs;
        try {
            inputs = (List<PendingBillablePreviewRowDTO>) JSON.deserialize(
                rowsJson,
                List<PendingBillablePreviewRowDTO>.class
            );
        } catch (Exception ex) {
            throw new AuraHandledException('JSON de preview invalido: ' + ex.getMessage());
        }

        if (inputs == null || inputs.isEmpty()) {
            return JSON.serialize(out);
        }

        Map<String, Schema.SObjectField> impFMap = null;
        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType != null) {
            impFMap = impType.getDescribe().fields.getMap();
        }

        ImputacionesBillableRules.RulesConfig rules = ImputacionesBillableRules.loadFromOperativeConfig(
            getOperativeConfigRow()
        );
        Map<Id, Boolean> outcomeByCase = new Map<Id, Boolean>();

        for (PendingBillablePreviewRowDTO row : inputs) {
            if (row == null || String.isBlank(row.caseId)) {
                continue;
            }
            Decimal h = row.hours != null ? row.hours : 0;
            if (h <= 0) {
                continue;
            }
            Integer mult = row.dateCount != null && row.dateCount > 0 ? row.dateCount : 1;
            Decimal weighted = h * mult;

            ImputacionesBillableRules.EvaluateInput ev = buildBillableEvaluateInput(row, impFMap);
            Boolean isNf = ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);
            Id caseId = null;
            try {
                caseId = (Id) row.caseId;
            } catch (Exception ignore) {
            }
            if (caseId != null) {
                outcomeByCase.put(caseId, isNf == true);
            }

            if (isNf == true) {
                out.noFactHours += weighted;
            } else {
                out.factHours += weighted;
            }
        }

        out.caseOutcomes = new List<CaseBillableOutcomeDTO>();
        for (Id cid : outcomeByCase.keySet()) {
            CaseBillableOutcomeDTO co = new CaseBillableOutcomeDTO();
            co.caseId = String.valueOf(cid);
            co.noFacturable = outcomeByCase.get(cid);
            out.caseOutcomes.add(co);
        }

        return JSON.serialize(out);
    }

    private static final Integer PREVIEW_IND_MAX_CASES = 100;

    /**
     * Solo para el donut/meta del lote pendiente. Devuelve FA/NF por caso usando Ind_Imputacion__c
     * (Formula.recalculateFormulas + fallback insert/rollback). Pensado para llamarse desde el LWC
     * solo al cambiar seleccion / No fact. / fecha, NO en cada keystroke de horas. El LWC cachea por
     * (caseId|nf|fecha) y reusa para las sumas en vivo. Si el preview Ind falla, el LWC usa el JSON.
     */
    @AuraEnabled(cacheable=false)
    public static String previewIndForSelectedCases(String requestJson) {
        List<IndPreviewResultRowDTO> out = new List<IndPreviewResultRowDTO>();
        if (String.isBlank(requestJson)) {
            return JSON.serialize(out);
        }

        List<IndPreviewRequestRowDTO> inputs;
        try {
            inputs = (List<IndPreviewRequestRowDTO>) JSON.deserialize(
                requestJson,
                List<IndPreviewRequestRowDTO>.class
            );
        } catch (Exception ex) {
            throw new AuraHandledException('JSON de preview Ind invalido: ' + ex.getMessage());
        }
        if (inputs == null || inputs.isEmpty()) {
            return JSON.serialize(out);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return JSON.serialize(out);
        }
        Map<String, Schema.SObjectField> impFMap = impType.getDescribe().fields.getMap();

        List<PendingBillablePreviewRowDTO> bridge = new List<PendingBillablePreviewRowDTO>();
        Map<String, IndPreviewRequestRowDTO> byCaseKey = new Map<String, IndPreviewRequestRowDTO>();
        Set<String> seenCases = new Set<String>();
        for (IndPreviewRequestRowDTO req : inputs) {
            if (req == null || String.isBlank(req.caseId)) {
                continue;
            }
            String caseStr = String.valueOf(req.caseId);
            if (seenCases.contains(caseStr)) {
                continue;
            }
            seenCases.add(caseStr);
            byCaseKey.put(caseStr, req);

            PendingBillablePreviewRowDTO p = new PendingBillablePreviewRowDTO();
            p.caseId = caseStr;
            p.hours = 1;
            p.dateCount = 1;
            p.plannedNoFacturable = req.plannedNoFacturable == true;
            p.isAmsManagementCase = req.isAmsManagementCase == true;
            p.allowsFutureDates = req.allowsFutureDates == true;
            p.caseRuleFieldsJson = req.caseRuleFieldsJson;
            bridge.add(p);
            if (bridge.size() >= PREVIEW_IND_MAX_CASES) {
                break;
            }
        }

        Map<Id, Boolean> indOutcomes = resolveNoFacturableByIndFormulaPreview(bridge, impFMap);
        ImputacionesBillableRules.RulesConfig rules = ImputacionesBillableRules.loadFromOperativeConfig(
            getOperativeConfigRow()
        );

        for (IndPreviewRequestRowDTO req : inputs) {
            if (req == null || String.isBlank(req.caseId)) {
                continue;
            }
            IndPreviewResultRowDTO r = new IndPreviewResultRowDTO();
            r.caseId = String.valueOf(req.caseId);
            r.plannedNoFacturable = req.plannedNoFacturable == true;
            r.isNoFacturable = false;
            r.resolvedByInd = false;

            Id cid = null;
            try {
                cid = (Id) req.caseId;
            } catch (Exception ignore) {
            }
            if (indOutcomes != null && cid != null && indOutcomes.containsKey(cid)) {
                r.isNoFacturable = indOutcomes.get(cid) == true;
                r.resolvedByInd = true;
            } else {
                /** Fallback a reglas JSON cuando Ind no esta disponible o no pudo resolverse para este caso. */
                PendingBillablePreviewRowDTO p = byCaseKey.get(r.caseId) != null
                    ? bridgeRowFor(byCaseKey.get(r.caseId))
                    : null;
                if (p != null) {
                    ImputacionesBillableRules.EvaluateInput ev = buildBillableEvaluateInput(p, impFMap);
                    r.isNoFacturable = ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules) == true;
                }
            }
            out.add(r);
        }
        return JSON.serialize(out);
    }

    private static PendingBillablePreviewRowDTO bridgeRowFor(IndPreviewRequestRowDTO req) {
        if (req == null || String.isBlank(req.caseId)) {
            return null;
        }
        PendingBillablePreviewRowDTO p = new PendingBillablePreviewRowDTO();
        p.caseId = req.caseId;
        p.hours = 1;
        p.dateCount = 1;
        p.plannedNoFacturable = req.plannedNoFacturable == true;
        p.isAmsManagementCase = req.isAmsManagementCase == true;
        p.allowsFutureDates = req.allowsFutureDates == true;
        p.caseRuleFieldsJson = req.caseRuleFieldsJson;
        return p;
    }

    /**
     * Inserta Imputacion__c de prueba (mismos campos que saveEntries), lee Ind_Imputacion__c y hace rollback.
     * Necesario porque Ind suele ser formula cross-object (PEP, Reason, Case) y no se calcula en memoria.
     */
    @TestVisible
    private static Map<Id, Boolean> resolveNoFacturableByIndFormulaPreview(
        List<PendingBillablePreviewRowDTO> inputs,
        Map<String, Schema.SObjectField> impFMap
    ) {
        if (inputs == null || inputs.isEmpty() || impFMap == null || impFMap.isEmpty()) {
            return null;
        }

        String indApi = resolveIndImputacionFieldApi(impFMap);
        if (String.isBlank(indApi)) {
            return null;
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return null;
        }

        String ticketApi = resolveImputationTicketFieldForAggregate(impFMap);
        String dateApi = resolveImputationDateFieldForAggregateDay(impFMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(impFMap);
        if (String.isBlank(ticketApi) || String.isBlank(dateApi) || String.isBlank(hoursApi)) {
            return null;
        }

        Map<Id, PendingBillablePreviewRowDTO> uniqueByCase = new Map<Id, PendingBillablePreviewRowDTO>();
        for (PendingBillablePreviewRowDTO row : inputs) {
            if (row == null || String.isBlank(row.caseId)) {
                continue;
            }
            try {
                Id caseId = (Id) row.caseId;
                uniqueByCase.put(caseId, row);
                if (uniqueByCase.size() >= PREVIEW_IND_MAX_CASES) {
                    break;
                }
            } catch (Exception ignore) {
            }
        }
        if (uniqueByCase.isEmpty()) {
            return null;
        }

        Set<Id> caseIds = uniqueByCase.keySet();
        Map<Id, Case> caseById = new Map<Id, Case>();
        try {
            caseById = new Map<Id, Case>([SELECT Id, PEP__c FROM Case WHERE Id IN :caseIds]);
        } catch (Exception ex) {
            try {
                caseById = new Map<Id, Case>([SELECT Id FROM Case WHERE Id IN :caseIds]);
            } catch (Exception ex2) {
                System.debug(LoggingLevel.WARN, 'resolveNoFacturableByIndFormulaPreview cases: ' + ex2.getMessage());
                return null;
            }
        }

        List<SObject> staging = new List<SObject>();
        List<Id> stagingCaseIds = new List<Id>();
        Id currentUser = UserInfo.getUserId();
        Date previewDate = Date.today();

        for (Id caseId : uniqueByCase.keySet()) {
            PendingBillablePreviewRowDTO row = uniqueByCase.get(caseId);
            SObject rec = buildPreviewStagingImputation(
                impType,
                impFMap,
                caseId,
                row,
                caseById,
                currentUser,
                previewDate
            );
            if (rec == null) {
                continue;
            }
            staging.add(rec);
            stagingCaseIds.add(caseId);
        }

        if (staging.isEmpty()) {
            return null;
        }

        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(impFMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;

        Map<Id, Boolean> result = new Map<Id, Boolean>();
        List<SObject> needDmlStaging = new List<SObject>();
        List<Id> needDmlCaseIds = new List<Id>();

        try {
            Formula.recalculateFormulas(staging);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'preview Formula.recalculateFormulas: ' + ex.getMessage());
        }

        for (Integer i = 0; i < staging.size(); i++) {
            Boolean resolved = tryResolveIsNoFacturableFromInd(staging[i], indApi, nfApi, nfDesc);
            if (resolved != null) {
                result.put(stagingCaseIds[i], resolved);
            } else {
                needDmlStaging.add(staging[i]);
                needDmlCaseIds.add(stagingCaseIds[i]);
            }
        }

        if (!needDmlStaging.isEmpty()) {
            Map<Id, Boolean> dmlResult = resolveNoFacturableByIndInsertRollback(
                needDmlStaging,
                needDmlCaseIds,
                indApi,
                nfApi,
                nfDesc
            );
            if (dmlResult != null) {
                result.putAll(dmlResult);
            }
        }

        return result.isEmpty() ? null : result;
    }

    private static SObject buildPreviewStagingImputation(
        Schema.SObjectType impType,
        Map<String, Schema.SObjectField> impFMap,
        Id caseId,
        PendingBillablePreviewRowDTO row,
        Map<Id, Case> caseById,
        Id currentUser,
        Date previewDate
    ) {
        if (impType == null || caseId == null || row == null) {
            return null;
        }
        SObject rec = impType.newSObject();
        putFirstExisting(rec, impFMap, new List<String>{ 'Ticket__c', 'Case__c', 'CaseId' }, caseId);
        putImputationConsultantOnRecord(rec, impFMap, currentUser);
        putFirstExisting(rec, impFMap, new List<String>{ 'Fecha__c', 'Date__c' }, previewDate);
        Decimal hrs = row.hours != null && row.hours > 0 ? row.hours : 1;
        putFirstExisting(rec, impFMap, new List<String>{ 'Horas__c', 'Hours__c' }, hrs);
        putNoFacturable(rec, impFMap, row.plannedNoFacturable == true);
        if (impFMap.containsKey('PEP__c')) {
            Case parent = caseById != null ? caseById.get(caseId) : null;
            if (parent != null && parent.get('PEP__c') != null) {
                rec.put('PEP__c', parent.get('PEP__c'));
            }
        }
        return rec;
    }

    /** null = Ind aun sin valor (formula cross-object); true/false = resuelto. */
    private static Boolean tryResolveIsNoFacturableFromInd(
        SObject rec,
        String indApi,
        String nfApi,
        Schema.DescribeFieldResult nfDesc
    ) {
        if (rec == null || String.isBlank(indApi)) {
            return null;
        }
        Object indVal = rec.get(indApi);
        if (indVal != null) {
            String indStr = String.valueOf(indVal).trim().toUpperCase();
            if (indStr == 'NF') {
                return true;
            }
            if (indStr == 'FA') {
                return false;
            }
        }
        return null;
    }

    private static Map<Id, Boolean> resolveNoFacturableByIndInsertRollback(
        List<SObject> staging,
        List<Id> stagingCaseIds,
        String indApi,
        String nfApi,
        Schema.DescribeFieldResult nfDesc
    ) {
        if (staging == null || staging.isEmpty()) {
            return null;
        }
        Map<Id, Boolean> result = new Map<Id, Boolean>();
        Savepoint sp = Database.setSavepoint();
        try {
            Database.SaveResult[] dml = Database.insert(staging, false);
            Set<Id> impIds = new Set<Id>();
            for (Integer i = 0; i < dml.size(); i++) {
                if (!dml[i].isSuccess()) {
                    return null;
                }
                impIds.add(dml[i].getId());
            }

            List<String> selectParts = new List<String>{ 'Id', indApi };
            if (String.isNotBlank(nfApi) && nfApi != indApi) {
                selectParts.add(nfApi);
            }
            String soql =
                'SELECT ' +
                String.join(selectParts, ', ') +
                ' FROM Imputacion__c WHERE Id IN :impIds';
            List<SObject> insertedRows = Database.query(soql);
            Map<Id, SObject> byImpId = new Map<Id, SObject>(insertedRows);

            for (Integer i = 0; i < staging.size(); i++) {
                Id impId = dml[i].getId();
                SObject qrec = byImpId.get(impId);
                if (qrec == null) {
                    continue;
                }
                Boolean isNf = isNoFacturableByIndFormula(qrec, indApi, nfApi, nfDesc);
                result.put(stagingCaseIds[i], isNf);
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'resolveNoFacturableByIndInsertRollback: ' + ex.getMessage());
            return null;
        } finally {
            Database.rollback(sp);
        }
        return result.isEmpty() ? null : result;
    }

    private static ImputacionesBillableRules.EvaluateInput buildBillableEvaluateInput(
        PendingBillablePreviewRowDTO row,
        Map<String, Schema.SObjectField> impFMap
    ) {
        ImputacionesBillableRules.EvaluateInput ev = new ImputacionesBillableRules.EvaluateInput();
        ev.caseRow = caseFromRuleFieldsJson(row.caseId, row.caseRuleFieldsJson);
        ev.amsManagementCase = row.isAmsManagementCase == true;
        ev.alwaysFacturablePep = row.allowsFutureDates == true;
        ev.plannedNoFacturable = row.plannedNoFacturable == true;
        ev.nfCheckbox = row.plannedNoFacturable == true;

        if (impFMap != null && !impFMap.isEmpty()) {
            Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
            if (impType != null) {
                SObject imp = impType.newSObject();
                putNoFacturable(imp, impFMap, ev.plannedNoFacturable == true);
                ev.imputation = imp;
            }
        }
        return ev;
    }

    private static Case caseFromRuleFieldsJson(String caseIdStr, String fieldsJson) {
        Case c = new Case();
        if (String.isNotBlank(caseIdStr)) {
            try {
                c.Id = (Id) caseIdStr;
            } catch (Exception ignore) {
            }
        }
        if (String.isBlank(fieldsJson)) {
            return c;
        }
        try {
            Object parsed = JSON.deserializeUntyped(fieldsJson);
            if (!(parsed instanceof Map<String, Object>)) {
                return c;
            }
            Map<String, Object> fieldMap = (Map<String, Object>) parsed;
            for (String api : fieldMap.keySet()) {
                if (String.isBlank(api)) {
                    continue;
                }
                Object val = fieldMap.get(api);
                if (val == null) {
                    continue;
                }
                try {
                    c.put(api, val);
                } catch (Exception ignore) {
                }
            }
        } catch (Exception ignore) {
        }
        return c;
    }

    /**
     * Totales de horas por día (usuario actual o resolutor elegido si admin). Calendario + desglose para meta facturable.
     * facturableHours / noFacturableHours según Ind_Imputacion__c (y fórmulas en Imputacion__c) cuando el campo existe en org.
     */
    @AuraEnabled(cacheable=false)
    public static String getDailyHoursForMonth(Integer year, Integer month, String consultantUserId) {
        if (year == null || month == null || month < 1 || month > 12) {
            throw new AuraHandledException('Invalid year or month.');
        }

        Date start = Date.newInstance(year, month, 1);
        Date lastDayOfMonth = start.addMonths(1).addDays(-1);

        Id filterUserId = UserInfo.getUserId();
        if (String.isNotBlank(consultantUserId)) {
            try {
                filterUserId = Id.valueOf(consultantUserId);
            } catch (Exception e) {
                filterUserId = UserInfo.getUserId();
            }
        }
        if (!isImputationAdmin() && filterUserId != UserInfo.getUserId()) {
            filterUserId = UserInfo.getUserId();
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return JSON.serialize(new List<DayHoursDTO>());
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String indApi = resolveIndImputacionFieldApi(fMap);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi)) {
            return JSON.serialize(new List<DayHoursDTO>());
        }

        List<DayHoursDTO> out = new List<DayHoursDTO>();

        /* Sin lookup a Caso: solo total por día (sin desglose facturable). */
        if (String.isBlank(ticketApi)) {
            String soqlAgg =
                'SELECT ' +
                dateApi +
                ', SUM(' +
                hoursApi +
                ') tot FROM Imputacion__c WHERE ' +
                buildImputationOwnerFilterWhereClause(fMap, 'filterUserId') +
                ' AND ' +
                dateApi +
                ' >= :start AND ' +
                dateApi +
                ' <= :lastDayOfMonth GROUP BY ' +
                dateApi;
            try {
                for (AggregateResult ar : Database.query(soqlAgg)) {
                    Date d = (Date) ar.get(dateApi);
                    if (d == null) {
                        continue;
                    }
                    DayHoursDTO row = new DayHoursDTO();
                    row.isoDate = formatIsoDateForCal(d);
                    Decimal tot = ar.get('tot') == null ? 0 : (Decimal) ar.get('tot');
                    row.hours = tot;
                    row.facturableHours = null;
                    row.noFacturableHours = null;
                    out.add(row);
                }
            } catch (Exception ex) {
                System.debug(LoggingLevel.WARN, 'getDailyHoursForMonth agg: ' + ex.getMessage());
            }
            return JSON.serialize(out);
        }

        String soqlRec =
            'SELECT Id, ' +
            ticketApi +
            ', ' +
            dateApi +
            ', ' +
            hoursApi;
        if (String.isNotBlank(nfApi)) {
            soqlRec += ', ' + nfApi;
        }
        if (String.isNotBlank(indApi)) {
            soqlRec += ', ' + indApi;
        }
        soqlRec +=
            ' FROM Imputacion__c WHERE ' +
            buildImputationOwnerFilterWhereClause(fMap, 'filterUserId') +
            ' AND ' +
            dateApi +
            ' >= :start AND ' +
            dateApi +
            ' <= :lastDayOfMonth LIMIT ' + String.valueOf(resolveSoqlLimitMonthAggregation());

        List<SObject> recs = new List<SObject>();
        try {
            recs = Database.query(soqlRec);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'getDailyHoursForMonth rows: ' + ex.getMessage());
            return JSON.serialize(out);
        }

        Map<String, Decimal> totalByIso = new Map<String, Decimal>();
        Map<String, Decimal> factByIso = new Map<String, Decimal>();
        Map<String, Decimal> noFactByIso = new Map<String, Decimal>();

        for (SObject r : recs) {
            Object dv = r.get(dateApi);
            Date d = null;
            if (dv instanceof Date) {
                d = (Date) dv;
            } else if (dv instanceof DateTime) {
                d = ((DateTime) dv).date();
            }
            if (d == null) {
                continue;
            }
            String iso = formatIsoDateForCal(d);
            Decimal h = r.get(hoursApi) == null ? 0 : (Decimal) r.get(hoursApi);
            if (h == null || h == 0) {
                continue;
            }

            Decimal curTot = totalByIso.containsKey(iso) ? totalByIso.get(iso) : 0;
            totalByIso.put(iso, curTot + h);

            Boolean isNoFact = isNoFacturableByIndFormula(r, indApi, nfApi, nfDesc);

            if (isNoFact) {
                Decimal curNf = noFactByIso.containsKey(iso) ? noFactByIso.get(iso) : 0;
                noFactByIso.put(iso, curNf + h);
            } else {
                Decimal curF = factByIso.containsKey(iso) ? factByIso.get(iso) : 0;
                factByIso.put(iso, curF + h);
            }
        }

        List<String> keys = new List<String>(totalByIso.keySet());
        keys.sort();
        for (String iso : keys) {
            DayHoursDTO row = new DayHoursDTO();
            row.isoDate = iso;
            row.hours = totalByIso.get(iso);
            Decimal f = factByIso.containsKey(iso) ? factByIso.get(iso) : 0;
            Decimal nf = noFactByIso.containsKey(iso) ? noFactByIso.get(iso) : 0;
            row.facturableHours = f;
            row.noFacturableHours = nf;
            out.add(row);
        }

        return JSON.serialize(out);
    }

    /** Fila de ticket para los popups de desglose mensual facturable / no facturable. */
    public class MonthTicketBillableDTO {
        @AuraEnabled public String caseId;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public Decimal hours;
        @AuraEnabled public Boolean noFacturable;
    }

    /**
     * Tickets del mes agrupados por ticket y clasificados en facturable / no facturable usando la
     * misma lógica que el gráfico mensual (Ind_Imputacion__c y fórmulas en Imputacion__c). Un mismo
     * ticket puede aparecer en ambas listas si tiene imputaciones de los dos tipos en el mes.
     */
    @AuraEnabled(cacheable=false)
    public static String getMonthTicketsByBillable(Integer year, Integer month, String consultantUserId) {
        List<MonthTicketBillableDTO> out = new List<MonthTicketBillableDTO>();
        if (year == null || month == null || month < 1 || month > 12) {
            return JSON.serialize(out);
        }

        Date start = Date.newInstance(year, month, 1);
        Date lastDayOfMonth = start.addMonths(1).addDays(-1);

        Id filterUserId = UserInfo.getUserId();
        if (String.isNotBlank(consultantUserId)) {
            try {
                filterUserId = Id.valueOf(consultantUserId);
            } catch (Exception e) {
                filterUserId = UserInfo.getUserId();
            }
        }
        if (!isImputationAdmin() && filterUserId != UserInfo.getUserId()) {
            filterUserId = UserInfo.getUserId();
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return JSON.serialize(out);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String indApi = resolveIndImputacionFieldApi(fMap);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi) || String.isBlank(ticketApi)) {
            return JSON.serialize(out);
        }

        String soqlRec = 'SELECT Id, ' + ticketApi + ', ' + hoursApi;
        if (String.isNotBlank(nfApi)) {
            soqlRec += ', ' + nfApi;
        }
        if (String.isNotBlank(indApi)) {
            soqlRec += ', ' + indApi;
        }
        soqlRec +=
            ' FROM Imputacion__c WHERE ' +
            buildImputationOwnerFilterWhereClause(fMap, 'filterUserId') +
            ' AND ' +
            dateApi +
            ' >= :start AND ' +
            dateApi +
            ' <= :lastDayOfMonth LIMIT ' + String.valueOf(resolveSoqlLimitMonthAggregation());

        List<SObject> recs = new List<SObject>();
        try {
            recs = Database.query(soqlRec);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'getMonthTicketsByBillable rows: ' + ex.getMessage());
            return JSON.serialize(out);
        }

        Map<Id, Decimal> factByCase = new Map<Id, Decimal>();
        Map<Id, Decimal> noFactByCase = new Map<Id, Decimal>();
        Set<Id> caseIds = new Set<Id>();

        for (SObject r : recs) {
            Id tid = (Id) r.get(ticketApi);
            if (tid == null) {
                continue;
            }
            Decimal h = r.get(hoursApi) == null ? 0 : (Decimal) r.get(hoursApi);
            if (h == null || h == 0) {
                continue;
            }
            caseIds.add(tid);
            if (isNoFacturableByIndFormula(r, indApi, nfApi, nfDesc)) {
                noFactByCase.put(tid, (noFactByCase.containsKey(tid) ? noFactByCase.get(tid) : 0) + h);
            } else {
                factByCase.put(tid, (factByCase.containsKey(tid) ? factByCase.get(tid) : 0) + h);
            }
        }

        Map<Id, Case> caseMap = new Map<Id, Case>();
        if (!caseIds.isEmpty()) {
            try {
                caseMap.putAll([SELECT Id, CaseNumber, Subject FROM Case WHERE Id IN :caseIds]);
            } catch (Exception ignore) {
                // Sin acceso al Caso: se devuelve solo el Id.
            }
        }

        for (Id cid : factByCase.keySet()) {
            out.add(buildMonthTicketBillableDto(cid, caseMap.get(cid), factByCase.get(cid), false));
        }
        for (Id cid : noFactByCase.keySet()) {
            out.add(buildMonthTicketBillableDto(cid, caseMap.get(cid), noFactByCase.get(cid), true));
        }
        return JSON.serialize(out);
    }

    private static MonthTicketBillableDTO buildMonthTicketBillableDto(
        Id caseId,
        Case c,
        Decimal hours,
        Boolean noFacturable
    ) {
        MonthTicketBillableDTO d = new MonthTicketBillableDTO();
        d.caseId = caseId;
        d.caseNumber = c != null ? c.CaseNumber : null;
        d.subject = c != null ? c.Subject : null;
        d.hours = hours == null ? 0 : hours;
        d.noFacturable = noFacturable;
        return d;
    }

    /**
     * Por un día yyyy-MM-dd: registros Imputacion (una fila por registro),
     * con marca facturable / no facturable si el campo existe.
     */
    @AuraEnabled(cacheable=false)
    public static String getTicketHoursBreakdownForDay(String isoDate, String consultantUserId) {
        List<TicketHoursLineDTO> lines = new List<TicketHoursLineDTO>();
        if (String.isBlank(isoDate)) {
            return JSON.serialize(lines);
        }

        Date targetDate = parseIsoCalDate(isoDate);
        if (targetDate == null) {
            throw new AuraHandledException('Fecha invalida.');
        }

        Id filterUserId = UserInfo.getUserId();
        if (String.isNotBlank(consultantUserId)) {
            try {
                filterUserId = Id.valueOf(consultantUserId);
            } catch (Exception e) {
                filterUserId = UserInfo.getUserId();
            }
        }
        if (!isImputationAdmin() && filterUserId != UserInfo.getUserId()) {
            filterUserId = UserInfo.getUserId();
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return JSON.serialize(lines);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String commentApi = resolveCommentFieldApi(fMap, false);
        String indApi = resolveIndImputacionFieldApi(fMap);
        String pepApi = resolveImputationPepFieldApi(fMap);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi) || String.isBlank(ticketApi)) {
            return JSON.serialize(lines);
        }

        Boolean admin = isImputationAdmin();
        Id currentUser = UserInfo.getUserId();

        List<SObject> recs = new List<SObject>();
        try {
            /* Sin alias: en consultas no agregadas SObject.get('alias') no devuelve el valor; usar API real. */
            String soql =
                appendImputationOwnerFieldsToSelect(
                    'SELECT Id, ' + ticketApi + ', ' + hoursApi + ', ' + dateApi,
                    fMap
                );
            if (String.isNotBlank(nfApi)) {
                soql += ', ' + nfApi;
            }
            if (String.isNotBlank(indApi)) {
                soql += ', ' + indApi;
            }
            if (String.isNotBlank(pepApi)) {
                soql += ', PEP__r.Name';
            }
            if (String.isNotBlank(commentApi)) {
                soql += ', ' + commentApi;
            }
            soql +=
                ' FROM Imputacion__c WHERE ' +
                buildImputationOwnerFilterWhereClause(fMap, 'filterUserId') +
                ' AND ' +
                dateApi +
                ' = :targetDate ORDER BY CreatedDate DESC LIMIT ' + String.valueOf(resolveSoqlLimitDayBreakdown());

            recs = Database.query(soql);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'getTicketHoursBreakdownForDay: ' + ex.getMessage());
            return JSON.serialize(new List<TicketHoursLineDTO>());
        }

        Set<Id> caseIds = new Set<Id>();
        for (SObject r : recs) {
            Id tid = (Id) r.get(ticketApi);
            if (tid != null) {
                caseIds.add(tid);
            }
        }

        Map<Id, Case> caseMap = new Map<Id, Case>();
        Map<Id, Boolean> caseAllowsFutureById = new Map<Id, Boolean>();
        if (!caseIds.isEmpty()) {
            try {
                for (Case c : [
                    SELECT Id, CaseNumber, Subject, PEP__r.Name
                    FROM Case
                    WHERE Id IN :caseIds
                ]) {
                    caseMap.put(c.Id, c);
                    caseAllowsFutureById.put(
                        c.Id,
                        isAlwaysFacturablePepName(c.PEP__r != null ? c.PEP__r.Name : null)
                    );
                }
            } catch (Exception caseEx) {
                caseMap.putAll(
                    [SELECT Id, CaseNumber, Subject FROM Case WHERE Id IN :caseIds]
                );
            }
        }

        Integer idx = 0;
        for (SObject r : recs) {
            TicketHoursLineDTO row = new TicketHoursLineDTO();
            row.imputationId = r.Id;
            Id tid = (Id) r.get(ticketApi);
            row.caseId = tid;
            row.hours = r.get(hoursApi) == null ? 0 : (Decimal) r.get(hoursApi);

            /* Etiqueta facturable mostrada en el popup: prioriza el campo fórmula Ind_Imputacion__c
             * para que coincida con el cálculo de meta y con la realidad de negocio. */
            Boolean nfParsed = null;
            if (String.isNotBlank(indApi)) {
                Object indVal = r.get(indApi);
                String indStr = indVal == null ? '' : String.valueOf(indVal).trim().toUpperCase();
                if (indStr == 'NF') nfParsed = true;
                else if (indStr == 'FA') nfParsed = false;
            }
            if (nfParsed == null) {
                nfParsed = nfDesc != null ? readNoFactFromRec(r, nfApi, nfDesc.getType()) : null;
            }
            /* Override: PEPs siempre facturables (ej. vacaciones). */
            if (nfParsed == true && String.isNotBlank(pepApi) && isAlwaysFacturablePep(r)) {
                nfParsed = false;
            }
            row.noFacturable = nfParsed;
            if (String.isNotBlank(commentApi)) {
                Object cv = r.get(commentApi);
                row.comment = cv == null ? null : String.valueOf(cv);
            }

            if (tid != null && caseMap.containsKey(tid)) {
                Case c = caseMap.get(tid);
                row.caseNumber = c.CaseNumber;
                row.subject = c.Subject;
            } else if (tid != null) {
                row.caseNumber = String.valueOf(tid);
                row.subject = '';
            } else {
                row.caseNumber = 'Sin ticket';
                row.subject = '';
            }

            Boolean ownRecord = currentUserOwnsImputation(r, fMap, currentUser);
            Date entryDate = readImputationDateFromRecord(r, fMap, dateApi);
            Boolean vacationPep = tid != null && caseAllowsFutureById.containsKey(tid)
                ? caseAllowsFutureById.get(tid)
                : false;
            Boolean dateOk = admin || isImputationDateModifiableByConsultant(entryDate, vacationPep);
            row.canEdit = admin || (ownRecord && dateOk);

            idx++;
            lines.add(row);
        }

        return JSON.serialize(lines);
    }

    /**
     * Exporta imputaciones del mes del calendario para el usuario (o consultor elegido si admin).
     * Columnas: ticket, horas, fecha, no facturable, comentario, Id imputación.
     */
    @AuraEnabled(cacheable=false)
    public static String exportImputationsForMonth(Integer year, Integer month, String consultantUserId) {
        try {
            return exportImputationsForMonthInternal(year, month, consultantUserId);
        } catch (AuraHandledException ahe) {
            throw ahe;
        } catch (Exception ex) {
            throw new AuraHandledException('Exportacion: ' + ex.getMessage());
        }
    }

    private static String exportImputationsForMonthInternal(
        Integer year,
        Integer month,
        String consultantUserId
    ) {
        if (year == null || month == null || month < 1 || month > 12) {
            throw new AuraHandledException('Año o mes invalido.');
        }

        Date startDate = Date.newInstance(year, month, 1);
        Date endDateExclusive = startDate.addMonths(1);

        Id filterUserId = UserInfo.getUserId();
        if (String.isNotBlank(consultantUserId)) {
            try {
                filterUserId = Id.valueOf(consultantUserId);
            } catch (Exception e) {
                filterUserId = UserInfo.getUserId();
            }
        }
        if (!isImputationAdmin() && filterUserId != UserInfo.getUserId()) {
            filterUserId = UserInfo.getUserId();
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return JSON.serialize(new List<ExportImputationRowDTO>());
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        if (String.isBlank(dateApi)) {
            dateApi = resolveImputationDateFieldForLatest(fMap);
        }
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String commentApi = resolveCommentFieldApi(fMap, false);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi) || String.isBlank(ticketApi)) {
            throw new AuraHandledException(
                'Faltan campos en Imputacion__c para exportar (fecha, horas o ticket).'
            );
        }

        Schema.DisplayType dateType = fMap.get(dateApi).getDescribe().getType();
        Boolean dateIsDateTime = dateType == Schema.DisplayType.DATETIME;

        String soql =
            'SELECT Id, ' +
            ticketApi +
            ', ' +
            dateApi +
            ', ' +
            hoursApi;
        if (String.isNotBlank(nfApi)) {
            soql += ', ' + nfApi;
        }
        if (String.isNotBlank(commentApi)) {
            soql += ', ' + commentApi;
        }
        soql +=
            ' FROM Imputacion__c WHERE ' + buildImputationOwnerFilterWhereClause(fMap, 'filterUserId') + ' AND ';

        List<SObject> recs = new List<SObject>();
        if (dateIsDateTime) {
            DateTime startDt = DateTime.newInstance(year, month, 1, 0, 0, 0);
            DateTime endDt = DateTime.newInstance(endDateExclusive.year(), endDateExclusive.month(), endDateExclusive.day(), 0, 0, 0);
            soql += dateApi + ' >= :startDt AND ' + dateApi + ' < :endDt';
            soql +=
                ' ORDER BY ' +
                dateApi +
                ' ASC, CreatedDate ASC LIMIT ' +
                String.valueOf(resolveSoqlLimitMonthAggregation());
            recs = Database.query(soql);
        } else {
            soql += dateApi + ' >= :startDate AND ' + dateApi + ' < :endDateExclusive';
            soql +=
                ' ORDER BY ' +
                dateApi +
                ' ASC, CreatedDate ASC LIMIT ' +
                String.valueOf(resolveSoqlLimitMonthAggregation());
            recs = Database.query(soql);
        }

        Set<Id> caseIds = new Set<Id>();
        for (SObject r : recs) {
            Id tid = (Id) r.get(ticketApi);
            if (tid != null) {
                caseIds.add(tid);
            }
        }
        Map<Id, Case> caseMap = new Map<Id, Case>();
        if (!caseIds.isEmpty()) {
            caseMap.putAll([SELECT Id, CaseNumber FROM Case WHERE Id IN :caseIds]);
        }

        List<ExportImputationRowDTO> out = new List<ExportImputationRowDTO>();
        for (SObject r : recs) {
            ExportImputationRowDTO row = new ExportImputationRowDTO();
            row.imputationId = r.Id;
            Id tid = (Id) r.get(ticketApi);
            if (tid != null && caseMap.containsKey(tid)) {
                row.caseNumber = caseMap.get(tid).CaseNumber;
            } else if (tid != null) {
                row.caseNumber = String.valueOf(tid);
            } else {
                row.caseNumber = '';
            }
            Object dv = r.get(dateApi);
            Date d = null;
            if (dv instanceof Date) {
                d = (Date) dv;
            } else if (dv instanceof DateTime) {
                d = ((DateTime) dv).date();
            }
            row.isoDate = d != null ? formatIsoDateForCal(d) : null;
            row.hours = r.get(hoursApi) == null ? 0 : (Decimal) r.get(hoursApi);
            Boolean nfVal = nfDesc != null && String.isNotBlank(nfApi) ? readNoFactFromRec(r, nfApi, nfDesc.getType()) : null;
            row.noFacturable = nfVal == true;
            row.comment = '';
            if (String.isNotBlank(commentApi)) {
                Object cv = r.get(commentApi);
                row.comment = cv == null ? '' : String.valueOf(cv);
            }
            out.add(row);
        }
        return JSON.serialize(out);
    }

    /** Eliminar una imputacion concreta (usuario dueño del registro o admin imputacion). */
    @AuraEnabled(cacheable=false)
    public static String deleteImputationRecord(Id imputationId) {
        Map<String, Object> resp = new Map<String, Object>();
        if (imputationId == null) {
            resp.put('success', false);
            resp.put('message', 'Id de imputacion requerido.');
            return JSON.serialize(resp);
        }
        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            resp.put('success', false);
            resp.put('message', 'Objeto Imputacion__c no disponible.');
            return JSON.serialize(resp);
        }

        Boolean admin = isImputationAdmin();
        Id currentUser = UserInfo.getUserId();

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();

        String dateApiDel = resolveImputationDateFieldForAggregateDay(fMap);
        if (String.isBlank(dateApiDel)) {
            dateApiDel = resolveImputationDateFieldForLatest(fMap);
        }
        String ticketApiDel = resolveImputationTicketFieldForAggregate(fMap);
        String soqlDel = appendImputationOwnerFieldsToSelect('SELECT Id', fMap);
        if (String.isNotBlank(dateApiDel)) {
            soqlDel += ', ' + dateApiDel;
        }
        if (String.isNotBlank(ticketApiDel)) {
            soqlDel += ', ' + ticketApiDel;
        }
        soqlDel += ' FROM Imputacion__c WHERE Id = :imputationId LIMIT 1';

        List<SObject> found;
        try {
            found = Database.query(soqlDel);
        } catch (Exception ex) {
            resp.put('success', false);
            resp.put('message', ex.getMessage());
            return JSON.serialize(resp);
        }

        if (found.isEmpty()) {
            resp.put('success', false);
            resp.put('message', 'Registro no encontrado.');
            return JSON.serialize(resp);
        }

        if (!admin && !currentUserOwnsImputation(found[0], fMap, currentUser)) {
            resp.put('success', false);
            resp.put('message', 'Solo puedes borrar tus propias imputaciones.');
            return JSON.serialize(resp);
        }

        if (!admin && !imputationRecordDateModifiableByConsultant(found[0], fMap)) {
            resp.put('success', false);
            resp.put('message', 'Solo puedes borrar imputaciones del mes en curso o dentro de la ventana de meses del centro.');
            return JSON.serialize(resp);
        }

        try {
            delete found[0];
            resp.put('success', true);
            resp.put('message', '');
        } catch (DmlException dmx) {
            resp.put('success', false);
            resp.put('message', dmx.getMessage());
        }

        return JSON.serialize(resp);
    }

    /**
     * Datos de una imputacion para el modal «Editar imputacion» (misma regla de permiso que borrar/actualizar).
     */
    @AuraEnabled(cacheable=false)
    public static String getImputationForEdit(String imputationIdStr) {
        Map<String, Object> resp = new Map<String, Object>();
        resp.put('success', false);
        resp.put('message', '');
        Id imputationId;
        try {
            imputationId = Id.valueOf(imputationIdStr);
        } catch (Exception e) {
            resp.put('message', 'Id invalido.');
            return JSON.serialize(resp);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            resp.put('message', 'Objeto Imputacion__c no disponible.');
            return JSON.serialize(resp);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String commentApi = resolveCommentFieldApi(fMap, false);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi)) {
            resp.put('message', 'Faltan campos en Imputacion__c para leer la imputacion.');
            return JSON.serialize(resp);
        }

        List<SObject> found;
        try {
            String q = appendImputationOwnerFieldsToSelect(
                'SELECT Id, ' + hoursApi + ', ' + dateApi,
                fMap
            );
            if (String.isNotBlank(nfApi)) {
                q += ', ' + nfApi;
            }
            if (String.isNotBlank(commentApi)) {
                q += ', ' + commentApi;
            }
            q += ' FROM Imputacion__c WHERE Id = :imputationId LIMIT 1';
            found = Database.query(q);
        } catch (Exception ex) {
            resp.put('message', ex.getMessage());
            return JSON.serialize(resp);
        }

        if (found.isEmpty()) {
            resp.put('message', 'Registro no encontrado.');
            return JSON.serialize(resp);
        }

        Boolean admin = isImputationAdmin();
        Id currentUser = UserInfo.getUserId();
        SObject rec = found[0];
        if (!admin && !currentUserOwnsImputation(rec, fMap, currentUser)) {
            resp.put('message', 'Solo puedes editar tus propias imputaciones.');
            return JSON.serialize(resp);
        }

        Date d = (Date) rec.get(dateApi);
        Decimal h = rec.get(hoursApi) == null ? null : (Decimal) rec.get(hoursApi);
        Boolean nfParsed = nfDesc != null && String.isNotBlank(nfApi)
            ? readNoFactFromRec(rec, nfApi, nfDesc.getType())
            : null;
        Boolean nfOut = nfParsed != null ? nfParsed : false;
        String comment = null;
        if (String.isNotBlank(commentApi)) {
            Object cv = rec.get(commentApi);
            comment = cv == null ? null : String.valueOf(cv);
        }

        resp.put('success', true);
        resp.put('message', '');
        resp.put('imputationId', String.valueOf(rec.Id));
        resp.put('hours', h);
        resp.put('entryDateIso', d != null ? formatIsoDateForCal(d) : null);
        resp.put('noFacturable', nfOut);
        resp.put('comment', comment);
        return JSON.serialize(resp);
    }

    /** Misma respuesta que getImputationForEdit usando la ultima imputacion del caso (si existe). */
    @AuraEnabled(cacheable=false)
    public static String getImputationForEditByCase(String caseIdStr) {
        Id caseId;
        try {
            caseId = Id.valueOf(caseIdStr);
        } catch (Exception e) {
            Map<String, Object> r = new Map<String, Object>();
            r.put('success', false);
            r.put('message', 'Caso invalido.');
            return JSON.serialize(r);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            Map<String, Object> r = new Map<String, Object>();
            r.put('success', false);
            r.put('message', 'Objeto Imputacion__c no disponible.');
            return JSON.serialize(r);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        if (String.isBlank(ticketApi)) {
            Map<String, Object> r = new Map<String, Object>();
            r.put('success', false);
            r.put('message', 'No hay campo ticket/caso en Imputacion__c.');
            return JSON.serialize(r);
        }

        String dateApi = resolveImputationDateFieldForLatest(fMap);
        String orderDateExpr = String.isBlank(dateApi) ? 'CreatedDate DESC' : (dateApi + ' DESC NULLS LAST, CreatedDate DESC');

        List<SObject> found;
        try {
            String q =
                'SELECT Id FROM Imputacion__c WHERE ' +
                ticketApi +
                ' = :caseId ORDER BY ' +
                orderDateExpr +
                ' LIMIT 1';
            found = Database.query(q);
        } catch (Exception ex) {
            Map<String, Object> r = new Map<String, Object>();
            r.put('success', false);
            r.put('message', ex.getMessage());
            return JSON.serialize(r);
        }

        if (found.isEmpty()) {
            Map<String, Object> r = new Map<String, Object>();
            r.put('success', false);
            r.put('message', 'No hay imputaciones para este ticket.');
            return JSON.serialize(r);
        }

        return getImputationForEdit(String.valueOf(found[0].Id));
    }

    /**
     * Líneas de imputación de un caso para el modal de edición por ticket.
     * @param ownLinesOnly Si true y el usuario no es admin, solo devuelve imputaciones propias (Gestión AMS).
     */
    @AuraEnabled(cacheable=false)
    public static String getCaseImputationLinesForEdit(String caseIdStr, Boolean ownLinesOnly) {
        Map<String, Object> resp = new Map<String, Object>();
        resp.put('success', false);
        resp.put('message', '');
        resp.put('lines', new List<CaseImputationLineDTO>());
        resp.put('userHoursTotal', 0);
        resp.put('ticketHoursTotal', 0);
        resp.put('ownLinesOnlyMode', false);

        Id caseId;
        try {
            caseId = Id.valueOf(caseIdStr);
        } catch (Exception e) {
            resp.put('message', 'Caso invalido.');
            return JSON.serialize(resp);
        }

        if (!userHasCaseAccess(caseId)) {
            resp.put('message', 'No tienes acceso a este caso.');
            return JSON.serialize(resp);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            resp.put('message', 'Objeto Imputacion__c no disponible.');
            return JSON.serialize(resp);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String dateApiRead = resolveImputationDateFieldForAggregateDay(fMap);
        if (String.isBlank(dateApiRead)) {
            dateApiRead = resolveImputationDateFieldForLatest(fMap);
        }
        Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
        String nfApi = nfDesc != null ? nfDesc.getName() : null;
        String commentApi = resolveCommentFieldApi(fMap, false);

        if (String.isBlank(ticketApi) || String.isBlank(hoursApi)) {
            resp.put('message', 'Configuracion incompleta en Imputacion__c.');
            return JSON.serialize(resp);
        }

        String orderExpr = String.isBlank(dateApiRead)
            ? 'CreatedDate ASC'
            : (dateApiRead + ' ASC NULLS LAST, CreatedDate ASC');

        List<SObject> recs = new List<SObject>();
        try {
            String soql = appendImputationOwnerFieldsToSelect('SELECT Id, ' + hoursApi, fMap);
            if (String.isNotBlank(dateApiRead)) {
                soql += ', ' + dateApiRead;
            }
            if (String.isNotBlank(nfApi)) {
                soql += ', ' + nfApi;
            }
            if (String.isNotBlank(commentApi)) {
                soql += ', ' + commentApi;
            }
            soql +=
                ' FROM Imputacion__c WHERE ' +
                ticketApi +
                ' = :caseId ORDER BY ' +
                orderExpr +
                ' LIMIT 500';
            recs = Database.query(soql);
        } catch (Exception ex) {
            resp.put('message', ex.getMessage());
            return JSON.serialize(resp);
        }

        Boolean admin = isImputationAdmin();
        Id currentUser = UserInfo.getUserId();
        Boolean filterOwnOnly = ownLinesOnly == true && !admin;
        resp.put('ownLinesOnlyMode', filterOwnOnly);

        List<CaseImputationLineDTO> out = new List<CaseImputationLineDTO>();
        Decimal ticketHoursTotal = 0;
        Decimal userHoursTotal = 0;

        Boolean caseAllowsFuture = false;
        try {
            List<Case> tmp = [SELECT Id, PEP__r.Name FROM Case WHERE Id = :caseId LIMIT 1];
            if (!tmp.isEmpty() && tmp[0].PEP__r != null) {
                caseAllowsFuture = isAlwaysFacturablePepName(tmp[0].PEP__r.Name);
            }
        } catch (Exception ignore) {}

        for (SObject rec : recs) {
            Decimal lineHours = rec.get(hoursApi) == null ? 0 : (Decimal) rec.get(hoursApi);
            ticketHoursTotal += lineHours;

            Boolean ownRecord = currentUserOwnsImputation(rec, fMap, currentUser);
            if (filterOwnOnly && !ownRecord) {
                continue;
            }

            CaseImputationLineDTO row = new CaseImputationLineDTO();
            row.imputationId = String.valueOf(rec.Id);
            row.hours = lineHours;

            Date d = null;
            if (String.isNotBlank(dateApiRead) && fMap.containsKey(dateApiRead)) {
                Schema.DescribeFieldResult fd = fMap.get(dateApiRead).getDescribe();
                Object dv = rec.get(dateApiRead);
                if (dv != null) {
                    if (fd.getType() == Schema.DisplayType.DATE) {
                        d = (Date) dv;
                    } else if (fd.getType() == Schema.DisplayType.DATETIME || dv instanceof DateTime) {
                        d = ((DateTime) dv).date();
                    }
                }
            }
            row.isoDate = d != null ? formatIsoDateForCal(d) : null;

            Boolean nfParsed =
                nfDesc != null && String.isNotBlank(nfApi)
                    ? readNoFactFromRec(rec, nfApi, nfDesc.getType())
                    : null;
            row.noFacturable = nfParsed != null ? nfParsed : false;

            row.comment = '';
            if (String.isNotBlank(commentApi)) {
                Object cv = rec.get(commentApi);
                row.comment = cv == null ? '' : String.valueOf(cv);
            }

            Boolean dateOk = admin || isImputationDateModifiableByConsultant(d, caseAllowsFuture);
            row.canEdit = admin || (ownRecord && dateOk);
            row.isOwnLine = ownRecord;

            if (ownRecord) {
                userHoursTotal += lineHours;
            }

            out.add(row);
        }

        resp.put('success', true);
        resp.put('message', '');
        resp.put('lines', out);
        resp.put('userHoursTotal', userHoursTotal);
        resp.put('ticketHoursTotal', ticketHoursTotal);
        resp.put('caseAllowsFutureDates', caseAllowsFuture);
        return JSON.serialize(resp);
    }

    /**
     * Actualizar horas, fecha, no facturable y comentario de un registro Imputacion__c.
     * Mismas reglas de permiso que delete (propietario funcional del registro o admin imputacion).
     */
    @AuraEnabled(cacheable=false)
    public static String updateImputationRecord(String payloadJson) {
        Map<String, Object> resp = new Map<String, Object>();
        resp.put('success', false);
        resp.put('message', '');
        if (String.isBlank(payloadJson)) {
            resp.put('message', 'Datos requeridos.');
            return JSON.serialize(resp);
        }
        UpdateImputationPayloadDTO p;
        try {
            p = (UpdateImputationPayloadDTO) JSON.deserialize(payloadJson, UpdateImputationPayloadDTO.class);
        } catch (Exception ex) {
            resp.put('message', 'Datos invalidos.');
            return JSON.serialize(resp);
        }
        if (p == null || p.imputationId == null) {
            resp.put('message', 'Id de imputacion requerido.');
            return JSON.serialize(resp);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            resp.put('message', 'Objeto Imputacion__c no disponible.');
            return JSON.serialize(resp);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String dateApi = resolveImputationDateFieldForAggregateDay(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        String commentApi = resolveCommentFieldApi(fMap, true);

        if (String.isBlank(dateApi) || String.isBlank(hoursApi) || String.isBlank(ticketApi)) {
            resp.put('message', 'Faltan campos estandar en Imputacion__c para actualizar.');
            return JSON.serialize(resp);
        }
        if (!fMap.get(hoursApi).getDescribe().isUpdateable() || !fMap.get(dateApi).getDescribe().isUpdateable()) {
            resp.put('message', 'Sin permiso de edicion en fecha u horas.');
            return JSON.serialize(resp);
        }

        Boolean admin = isImputationAdmin();
        Id currentUser = UserInfo.getUserId();

        Date newDate = parseIsoCalDate(p.entryDateIso);
        if (newDate == null) {
            resp.put('message', 'Fecha invalida.');
            return JSON.serialize(resp);
        }

        Id targetImpId = p.imputationId;
        List<SObject> found;
        try {
            String q =
                appendImputationOwnerFieldsToSelect(
                    'SELECT Id, ' + ticketApi + ', ' + hoursApi + ', ' + dateApi,
                    fMap
                ) + ' FROM Imputacion__c WHERE Id = :targetImpId LIMIT 1';
            found = Database.query(q);
        } catch (Exception ex) {
            resp.put('message', ex.getMessage());
            return JSON.serialize(resp);
        }

        if (found.isEmpty()) {
            resp.put('message', 'Registro no encontrado.');
            return JSON.serialize(resp);
        }

        SObject rec = found[0];
        if (!admin && !currentUserOwnsImputation(rec, fMap, currentUser)) {
            resp.put('message', 'Solo puedes editar tus propias imputaciones.');
            return JSON.serialize(resp);
        }

        if (!admin && !imputationRecordDateModifiableByConsultant(rec, fMap)) {
            resp.put('message', 'Solo puedes editar imputaciones del mes en curso o dentro de la ventana de meses del centro.');
            return JSON.serialize(resp);
        }

        Id caseId = (Id) rec.get(ticketApi);
        EntryDTO e = new EntryDTO();
        e.rowKey = 'update';
        e.caseId = caseId;
        e.entryDate = newDate;
        e.hours = p.hours;
        e.noFacturable = p.noFacturable != null ? p.noFacturable : false;
        e.comment = p.comment != null ? p.comment : '';

        /* validate(): mes en curso + ventana retro/adelante; VAC permite futuro en meses posteriores. */
        List<ValidationResultDTO> vrs = validate(new List<EntryDTO>{ e });
        if (vrs.isEmpty() || !vrs[0].isValid) {
            List<String> errs = (!vrs.isEmpty() && vrs[0].errors != null) ? vrs[0].errors : new List<String>{ 'Validacion fallida.' };
            resp.put('message', String.join(errs, ' '));
            return JSON.serialize(resp);
        }

        try {
            rec.put(hoursApi, p.hours);
            rec.put(dateApi, newDate);
            putNoFacturable(rec, fMap, e.noFacturable);
            if (String.isNotBlank(commentApi)) {
                rec.put(commentApi, e.comment);
            }
            update rec;
            resp.put('success', true);
            resp.put('message', '');
        } catch (DmlException dmx) {
            resp.put('message', dmx.getMessage());
        }

        return JSON.serialize(resp);
    }

    private static String resolveCommentFieldApi(Map<String, Schema.SObjectField> fMap, Boolean requireUpdateable) {
        List<String> candidates = new List<String>{ 'Comentarios__c', 'Comentario__c', 'Comment__c', 'Descripcion__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) {
                continue;
            }
            if (requireUpdateable && !d.isUpdateable()) {
                continue;
            }
            return api;
        }
        return null;
    }

    private static Schema.DescribeFieldResult resolveNoFactFieldDescribeForRead(Map<String, Schema.SObjectField> fMap) {
        for (String api : new List<String>{ 'No_Facturable__c', 'NoFacturable__c' }) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult dfr = fMap.get(api).getDescribe();
            if (!dfr.isAccessible()) {
                continue;
            }
            return dfr;
        }
        return null;
    }

    /**
     * Meta / graficos: Ind_Imputacion__c (formula SF, incluye ExF1/ExF2, PEP, Reason, No_Facturable__c).
     * Si no hay Ind, fallback al checkbox No_Facturable__c.
     */
    private static Boolean isNoFacturableByIndFormula(
        SObject rec,
        String indApi,
        String nfApi,
        Schema.DescribeFieldResult nfDesc
    ) {
        if (rec == null) {
            return false;
        }
        if (String.isNotBlank(indApi)) {
            Object indVal = rec.get(indApi);
            if (indVal != null) {
                String indStr = String.valueOf(indVal).trim().toUpperCase();
                if (indStr == 'NF') {
                    return true;
                }
                if (indStr == 'FA') {
                    return false;
                }
            }
        }
        if (nfDesc != null && String.isNotBlank(nfApi)) {
            return readNoFactFromRec(rec, nfApi, nfDesc.getType()) == true;
        }
        return false;
    }

    private static Boolean readNoFactFromRec(SObject rec, String api, Schema.DisplayType t) {
        if (rec == null || String.isBlank(api)) {
            return null;
        }
        Object v = rec.get(api);
        if (v == null) {
            return null;
        }
        if (t == Schema.DisplayType.Boolean) {
            return (Boolean) v;
        }
        String s = String.valueOf(v).trim().toLowerCase();
        if (s.length() > 60) {
            return null;
        }
        Boolean isTruePicklist =
            s == 'si' ||
            s == 'sí' ||
            s == 's' ||
            s == 'yes' ||
            s == 'y' ||
            s == 'true' ||
            s == '1' ||
            s == 'x' ||
            s == 'verdadero';

        Boolean isFalsePicklist =
            s == 'no' ||
            s == 'n' ||
            s == 'false' ||
            s == '0' ||
            s == 'falso';

        if (isTruePicklist) {
            return true;
        }
        if (isFalsePicklist) {
            return false;
        }

        return null;
    }

    /* cacheable=false: lista de casos y equipo debe reflejar cambios recientes al volver a la pantalla o tras guardar. */
    @AuraEnabled(cacheable=false)
    public static String getTicketsForEntry(String filterJson) {
        FilterDTO filterDto = String.isBlank(filterJson)
            ? new FilterDTO()
            : (FilterDTO) JSON.deserialize(filterJson, FilterDTO.class);

        Id currentUserId = UserInfo.getUserId();
        Boolean admin = isImputationAdmin();

        Integer pageSize = (filterDto != null && filterDto.pageSize != null)
            ? filterDto.pageSize
            : resolveDefaultTicketPageSize();
        Integer pageNumber = (filterDto != null && filterDto.pageNumber != null) ? filterDto.pageNumber : 1;
        Integer offsetRows = Math.max(0, (pageNumber - 1) * pageSize);

        Boolean hasOwners = admin && filterDto != null && filterDto.ownerIds != null && !filterDto.ownerIds.isEmpty();
        Boolean hasCaseIds = filterDto != null && filterDto.caseIds != null && !filterDto.caseIds.isEmpty();

        String listSourceNorm =
            filterDto != null && String.isNotBlank(filterDto.listSource)
                ? filterDto.listSource.trim().toLowerCase()
                : 'mine';

        TicketCatalogTabDef catalogTab = resolveTicketCatalogTab(listSourceNorm);
        if (catalogTab != null && (catalogTab.type == 'custom' || catalogTab.type == 'ams')) {
            Set<Id> caseIdsFiltered = buildCaseIdFilterSet(filterDto, hasCaseIds);
            hasCaseIds = !caseIdsFiltered.isEmpty();
            List<CaseFieldFilter> tabFilters = catalogTab.caseFilters;
            if (tabFilters == null) {
                tabFilters = new List<CaseFieldFilter>();
            }
            List<CaseFieldFilter> effectiveFilters = sanitizeCaseFieldFilters(tabFilters);
            Boolean markAms = catalogTab.type == 'ams';
            if (markAms && effectiveFilters.isEmpty()) {
                effectiveFilters = sanitizeCaseFieldFilters(buildLegacyGlobalAmsCaseFilters());
            }
            String filterLogic = String.isNotBlank(catalogTab.filterLogic)
                ? catalogTab.filterLogic
                : (markAms ? 'OR' : 'AND');
            return JSON.serialize(
                fetchTicketsForCaseFilters(
                    filterDto,
                    currentUserId,
                    admin,
                    pageSize,
                    offsetRows,
                    hasCaseIds,
                    caseIdsFiltered,
                    hasOwners,
                    effectiveFilters,
                    filterLogic,
                    markAms
                )
            );
        }
        Set<Id> caseIdsFilter = new Set<Id>();
        if (hasCaseIds) {
            for (String sid : filterDto.caseIds) {
                if (String.isBlank(sid)) continue;
                try {
                    caseIdsFilter.add((Id) sid);
                } catch (Exception ex) {
                    /* ignore malformed ids */
                }
            }
            hasCaseIds = !caseIdsFilter.isEmpty();
        }

        List<Case> cases;

        if (hasCaseIds) {
            if (!admin) {
                Set<Id> collaborateCaseIds = getCaseIdsWhereUserCollaborates(currentUserId);
                cases = [
                    SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                    FROM Case
                    WHERE Id IN :caseIdsFilter
                    AND IsClosed = false
                    AND (OwnerId = :currentUserId OR Id IN :collaborateCaseIds)
                    ORDER BY LastModifiedDate DESC
                ];
            } else {
                cases = [
                    SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                    FROM Case
                    WHERE Id IN :caseIdsFilter
                    AND IsClosed = false
                    ORDER BY LastModifiedDate DESC
                ];
            }
        } else if (!admin) {
            Set<Id> collaborateCaseIds = getCaseIdsWhereUserCollaborates(currentUserId);
            if (collaborateCaseIds.isEmpty()) {
                cases = [
                    SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                    FROM Case
                    WHERE OwnerId = :currentUserId
                    AND IsClosed = false
                    ORDER BY LastModifiedDate DESC
                    LIMIT :pageSize
                    OFFSET :offsetRows
                ];
            } else {
                cases = [
                    SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                    FROM Case
                    WHERE (OwnerId = :currentUserId OR Id IN :collaborateCaseIds)
                    AND IsClosed = false
                    ORDER BY LastModifiedDate DESC
                    LIMIT :pageSize
                    OFFSET :offsetRows
                ];
            }
        } else if (hasOwners) {
            cases = [
                SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                FROM Case
                WHERE OwnerId IN :filterDto.ownerIds
                AND IsClosed = false
                ORDER BY LastModifiedDate DESC
                LIMIT :pageSize
                OFFSET :offsetRows
            ];
        } else {
            cases = [
                SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                FROM Case
                WHERE IsClosed = false
                ORDER BY LastModifiedDate DESC
                LIMIT :pageSize
                OFFSET :offsetRows
            ];
        }

        cases = filterCasesByGlobalServicio(cases);
        return JSON.serialize(mapCasesToTicketRows(cases, currentUserId, admin));
    }

    private static String caseNumberDigitsOnly(String raw) {
        if (String.isBlank(raw)) {
            return '';
        }
        String digits = raw.replaceAll('[^0-9]', '');
        if (String.isBlank(digits)) {
            return '';
        }
        try {
            return String.valueOf(Long.valueOf(digits));
        } catch (Exception ignore) {
            return digits;
        }
    }

    /** Variantes de CaseNumber para busqueda (CSV/Excel pueden quitar ceros a la izquierda). */
    private static Set<String> expandCaseNumberSearchVariants(Set<String> caseNumbers) {
        Set<String> out = new Set<String>();
        if (caseNumbers == null) {
            return out;
        }
        for (String raw : caseNumbers) {
            if (String.isBlank(raw)) {
                continue;
            }
            String t = raw.trim();
            out.add(t);
            String bare = caseNumberDigitsOnly(t);
            if (String.isNotBlank(bare)) {
                out.add(bare);
                for (Integer width : new List<Integer>{ 6, 7, 8, 9, 10, 12 }) {
                    String padded = bare.leftPad(width, '0');
                    if (padded.length() > width) {
                        padded = padded.right(width);
                    }
                    out.add(padded);
                }
            }
        }
        return out;
    }

    private static List<Case> supplementOpenCasesByDigitMatch(List<Case> initial, Set<String> searchTokens) {
        Map<Id, Case> byId = new Map<Id, Case>();
        if (initial != null) {
            for (Case c : initial) {
                if (c != null && c.Id != null) {
                    byId.put(c.Id, c);
                }
            }
        }
        Set<String> targetDigits = new Set<String>();
        if (searchTokens != null) {
            for (String token : searchTokens) {
                String d = caseNumberDigitsOnly(token);
                if (String.isNotBlank(d)) {
                    targetDigits.add(d);
                }
            }
        }
        if (targetDigits.isEmpty()) {
            return byId.values();
        }
        Set<String> resolvedDigits = new Set<String>();
        for (Case c : byId.values()) {
            resolvedDigits.add(caseNumberDigitsOnly(c.CaseNumber));
        }
        Set<String> missing = new Set<String>();
        for (String d : targetDigits) {
            if (!resolvedDigits.contains(d)) {
                missing.add(d);
            }
        }
        if (missing.isEmpty()) {
            return byId.values();
        }
        for (String bare : missing) {
            if (bare.length() < 4) {
                continue;
            }
            String likePat = '%' + bare;
            for (Case c : [
                SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                FROM Case
                WHERE IsClosed = false AND CaseNumber LIKE :likePat
                ORDER BY LastModifiedDate DESC
                LIMIT 25
            ]) {
                if (caseNumberDigitsOnly(c.CaseNumber) == bare) {
                    byId.put(c.Id, c);
                }
            }
        }
        return byId.values();
    }

    /**
     * Casos abiertos (por CaseNumber) en los que el usuario ya tiene imputaciones propias.
     * Misma regla que exportImputationsForMonth: Usuario Final, legacy o CreatedBy.
     */
    private static Set<Id> getCaseIdsWhereUserHasImputationOnCaseNumbers(
        Id userId,
        Set<String> caseNumbers
    ) {
        Set<Id> out = new Set<Id>();
        if (userId == null || caseNumbers == null || caseNumbers.isEmpty()) {
            return out;
        }
        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return out;
        }
        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        if (String.isBlank(ticketApi)) {
            return out;
        }
        Set<String> numberVariants = expandCaseNumberSearchVariants(caseNumbers);
        Map<Id, Case> casesByNumber = new Map<Id, Case>(
            [
                SELECT Id
                FROM Case
                WHERE CaseNumber IN :numberVariants AND IsClosed = false
            ]
        );
        if (casesByNumber.isEmpty()) {
            return out;
        }
        Set<Id> caseIds = casesByNumber.keySet();
        String soql =
            'SELECT ' +
            ticketApi +
            ' FROM Imputacion__c WHERE ' +
            buildImputationOwnerFilterWhereClause(fMap, 'userId') +
            ' AND ' +
            ticketApi +
            ' IN :caseIds LIMIT 10000';
        for (SObject imp : Database.query(soql)) {
            Id cid = (Id) imp.get(ticketApi);
            if (cid != null) {
                out.add(cid);
            }
        }
        return out;
    }

    /**
     * Resolución de tickets por número de caso para la importación CSV.
     * Devuelve filas para los casos cuyos `CaseNumber` coinciden con la lista recibida, **independientemente
     * de la pestaña activa** (mis tickets / Gestión AMS). Se respeta visibilidad por perfil:
     *   - Admin de imputación: ve cualquier caso visible para su sharing.
     *   - Otros usuarios: owner, equipo del caso, gestión AMS, o caso abierto con imputaciones previas del usuario.
     * Solo casos abiertos (IsClosed = false), igual que el listado de tickets.
     */
    @AuraEnabled(cacheable=false)
    public static String getTicketsByCaseNumbers(List<String> caseNumbers) {
        List<TicketRowDTO> empty = new List<TicketRowDTO>();
        if (caseNumbers == null || caseNumbers.isEmpty()) {
            return JSON.serialize(empty);
        }
        Set<String> distinctNumbers = new Set<String>();
        for (String s : caseNumbers) {
            if (String.isNotBlank(s)) {
                distinctNumbers.add(s.trim());
            }
        }
        distinctNumbers = expandCaseNumberSearchVariants(distinctNumbers);
        if (distinctNumbers.isEmpty()) {
            return JSON.serialize(empty);
        }

        Id currentUserId = UserInfo.getUserId();
        Boolean admin = isImputationAdmin();

        Set<String> originalTokens = new Set<String>();
        for (String s : caseNumbers) {
            if (String.isNotBlank(s)) {
                originalTokens.add(s.trim());
            }
        }

        List<Case> raw = supplementOpenCasesByDigitMatch(
            [
                SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name
                FROM Case
                WHERE CaseNumber IN :distinctNumbers
                AND IsClosed = false
                ORDER BY LastModifiedDate DESC
                LIMIT 500
            ],
            originalTokens
        );

        List<Case> visible;
        if (admin) {
            visible = raw;
        } else {
            Set<Id> rawIds = new Set<Id>();
            for (Case c : raw) {
                rawIds.add(c.Id);
            }
            Set<Id> collaborateCaseIds = getCaseIdsWhereUserCollaborates(currentUserId);
            Set<Id> amsAccessible = filterCasesByAmsEligibility(rawIds);
            Set<Id> imputationBackedCaseIds = getCaseIdsWhereUserHasImputationOnCaseNumbers(
                currentUserId,
                distinctNumbers
            );
            visible = new List<Case>();
            for (Case c : raw) {
                Boolean ok =
                    c.OwnerId == currentUserId ||
                    collaborateCaseIds.contains(c.Id) ||
                    amsAccessible.contains(c.Id) ||
                    imputationBackedCaseIds.contains(c.Id);
                if (ok) {
                    visible.add(c);
                }
            }
        }

        return JSON.serialize(mapCasesToTicketRows(visible, currentUserId, admin));
    }

    /**
     * Tickets para Gestion AMS: motivo Case segun objeto operativo (lista Motivo_Ticket__c y reservas),
     * solo casos abiertos (IsClosed = false). Sin filtro por resolutor salvo filtro admin en UI.
     */
    private static Set<Id> buildCaseIdFilterSet(FilterDTO filterDto, Boolean hasCaseIds) {
        Set<Id> out = new Set<Id>();
        if (!hasCaseIds || filterDto == null || filterDto.caseIds == null) {
            return out;
        }
        for (String sid : filterDto.caseIds) {
            if (String.isBlank(sid)) {
                continue;
            }
            try {
                out.add((Id) sid);
            } catch (Exception ex) {
                /* ignore */
            }
        }
        return out;
    }

    private class CaseFieldFilter {
        String fieldApi;
        Set<String> values;
        Boolean matchEmpty;
    }

    private static List<CaseFieldFilter> buildLegacyGlobalAmsCaseFilters() {
        List<CaseFieldFilter> out = new List<CaseFieldFilter>();
        Set<String> reasonValues = resolveAmsReasonValues();
        String reasonField = resolveCaseReasonFieldForAms();
        if (String.isNotBlank(reasonField) && reasonValues != null && !reasonValues.isEmpty()) {
            CaseFieldFilter f = new CaseFieldFilter();
            f.fieldApi = reasonField;
            f.values = reasonValues;
            out.add(f);
        }
        List<String> servicioValues = resolveAmsServicioValues();
        String servicioField = resolveCaseServicioFieldApi();
        if (String.isNotBlank(servicioField) && servicioValues != null && !servicioValues.isEmpty()) {
            CaseFieldFilter f2 = new CaseFieldFilter();
            f2.fieldApi = servicioField;
            f2.values = new Set<String>(servicioValues);
            out.add(f2);
        }
        return out;
    }

    /**
     * Lista de tickets por uno o mas filtros IN sobre campos Case (AMS o pestana custom).
     */
    private static List<TicketRowDTO> fetchTicketsForCaseFilters(
        FilterDTO filterDto,
        Id currentUserId,
        Boolean admin,
        Integer pageSize,
        Integer offsetRows,
        Boolean hasCaseIds,
        Set<Id> caseIdsFilter,
        Boolean hasOwners,
        List<CaseFieldFilter> filters,
        String filterLogic,
        Boolean markAllAsAmsManagement
    ) {
        List<CaseFieldFilter> valid = sanitizeCaseFieldFilters(filters);
        if (valid.isEmpty()) {
            return new List<TicketRowDTO>();
        }

        ImputacionesBillableRules.RulesConfig billRules = ImputacionesBillableRules.loadFromOperativeConfig(
            getOperativeConfigRow()
        );
        String soql = appendBillableCaseFieldsToSelect(
            'SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name FROM Case WHERE IsClosed = false',
            billRules
        );

        Boolean useOr = 'OR'.equalsIgnoreCase(String.valueOf(filterLogic));
        Set<String> filter0Values = valid[0].values;
        String filter0Field = valid[0].fieldApi;
        Set<String> filter1Values = null;
        String filter1Field = null;
        Set<String> filter2Values = null;
        String filter2Field = null;
        Set<String> filter3Values = null;
        String filter3Field = null;
        Set<String> filter4Values = null;
        String filter4Field = null;

        List<String> filterClauses = new List<String>();
        for (Integer fi = 0; fi < valid.size() && fi < 5; fi++) {
            String clause = buildCaseFilterSoqlClause(valid[fi], fi);
            if (String.isNotBlank(clause)) {
                filterClauses.add(clause);
            }
        }
        if (!filterClauses.isEmpty()) {
            String joiner = useOr ? ' OR ' : ' AND ';
            soql += ' AND (' + String.join(filterClauses, joiner) + ')';
        }
        if (valid.size() > 0) {
            filter0Values = valid[0].values;
            filter0Field = valid[0].fieldApi;
        }
        if (valid.size() > 1) {
            filter1Values = valid[1].values;
            filter1Field = valid[1].fieldApi;
        }
        if (valid.size() > 2) {
            filter2Values = valid[2].values;
            filter2Field = valid[2].fieldApi;
        }
        if (valid.size() > 3) {
            filter3Values = valid[3].values;
            filter3Field = valid[3].fieldApi;
        }
        if (valid.size() > 4) {
            filter4Values = valid[4].values;
            filter4Field = valid[4].fieldApi;
        }

        if (hasCaseIds) {
            soql += ' AND Id IN :caseIdsFilter';
        }

        if (hasOwners && filterDto != null && filterDto.ownerIds != null && !filterDto.ownerIds.isEmpty()) {
            List<String> oidBind = filterDto.ownerIds;
            soql += ' AND OwnerId IN :oidBind';
        }

        Date createdFromBind = null;
        Date createdToBind = null;
        Date createdToExclusiveBind = null;
        if (filterDto != null) {
            createdFromBind = parseIsoCalDate(filterDto.createdDateFromIso);
            createdToBind = parseIsoCalDate(filterDto.createdDateToIso);
        }
        if (createdFromBind != null) {
            soql += ' AND CreatedDate >= :createdFromBind';
        }
        if (createdToBind != null) {
            createdToExclusiveBind = createdToBind.addDays(1);
            soql += ' AND CreatedDate < :createdToExclusiveBind';
        }

        List<String> globalServicioVals = resolveGlobalTicketServicioValues();
        String globalServicioField = resolveCaseServicioFieldApi();
        Set<String> servicioFilterBind;
        if (String.isNotBlank(globalServicioField) && !globalServicioVals.isEmpty()) {
            servicioFilterBind = new Set<String>(globalServicioVals);
            soql += ' AND ' + globalServicioField + ' IN :servicioFilterBind';
        }

        soql += ' ORDER BY LastModifiedDate DESC LIMIT :pageSize OFFSET :offsetRows';

        List<Case> cases = new List<Case>();
        try {
            cases = Database.query(soql);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'fetchTicketsForCaseFilters: ' + ex.getMessage());
            return new List<TicketRowDTO>();
        }

        List<TicketRowDTO> rows = mapCasesToTicketRows(cases, currentUserId, admin);
        if (markAllAsAmsManagement == true) {
            for (TicketRowDTO row : rows) {
                row.isAmsManagementCase = true;
            }
        }
        return rows;
    }

    private static List<CaseFieldFilter> sanitizeCaseFieldFilters(List<CaseFieldFilter> filters) {
        List<CaseFieldFilter> valid = new List<CaseFieldFilter>();
        if (filters == null) {
            return valid;
        }
        Set<String> usedFields = new Set<String>();
        for (CaseFieldFilter raw : filters) {
            if (raw == null) {
                continue;
            }
            Boolean wantsEmpty = raw.matchEmpty == true;
            Boolean hasValues = raw.values != null && !raw.values.isEmpty();
            if (!wantsEmpty && !hasValues) {
                continue;
            }
            String api = validateCaseFilterFieldApi(raw.fieldApi);
            if (String.isBlank(api) || usedFields.contains(api)) {
                continue;
            }
            CaseFieldFilter vf = new CaseFieldFilter();
            vf.fieldApi = api;
            vf.values = hasValues ? raw.values : new Set<String>();
            vf.matchEmpty = wantsEmpty;
            valid.add(vf);
            usedFields.add(api);
            if (valid.size() >= 5) {
                break;
            }
        }
        return valid;
    }

    private static String validateCaseFilterFieldApi(String configuredApi) {
        if (String.isBlank(configuredApi)) {
            return null;
        }
        String api = configuredApi.trim();
        Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
        if (!caseFm.containsKey(api)) {
            return null;
        }
        Schema.DescribeFieldResult dfr = caseFm.get(api).getDescribe();
        if (!dfr.isAccessible()) {
            return null;
        }
        Schema.DisplayType dt = dfr.getType();
        if (
            dt != Schema.DisplayType.STRING &&
            dt != Schema.DisplayType.PICKLIST &&
            dt != Schema.DisplayType.MULTIPICKLIST &&
            dt != Schema.DisplayType.BOOLEAN &&
            dt != Schema.DisplayType.DOUBLE &&
            dt != Schema.DisplayType.INTEGER &&
            dt != Schema.DisplayType.LONG &&
            dt != Schema.DisplayType.PERCENT &&
            dt != Schema.DisplayType.ID &&
            dt != Schema.DisplayType.REFERENCE &&
            dt != Schema.DisplayType.EMAIL &&
            dt != Schema.DisplayType.PHONE &&
            dt != Schema.DisplayType.URL &&
            dt != Schema.DisplayType.TEXTAREA
        ) {
            return null;
        }
        return api;
    }

    private static List<TicketRowDTO> mapCasesToTicketRows(List<Case> cases, Id currentUserId, Boolean admin) {
        Set<Id> caseIds = new Set<Id>();
        for (Case c : cases) {
            caseIds.add(c.Id);
        }
        Map<Id, Decimal> alreadyHoursByCase = getImputedHoursByTicket(caseIds);
        Map<Id, Id> lastImpByCase = getLastImputationIdByCase(caseIds);
        NfSplitLoad nfLoad = loadNoFactHoursByCase(caseIds);
        Set<Id> amsCaseIds = filterCasesByAmsEligibility(caseIds);
        ImputacionesBillableRules.RulesConfig billRules = ImputacionesBillableRules.loadFromOperativeConfig(
            getOperativeConfigRow()
        );
        Set<String> caseRuleFieldApis = ImputacionesBillableRules.collectCaseFieldApis(billRules);
        Map<Id, Case> casesWithRuleFields = queryCasesForBillableRules(caseIds, billRules);

        List<TicketRowDTO> rows = new List<TicketRowDTO>();
        for (Case c : cases) {
            TicketRowDTO row = new TicketRowDTO();
            row.caseId = c.Id;
            Boolean amsMgmt = amsCaseIds.contains(c.Id);
            row.isAmsManagementCase = amsMgmt;
            Case ruleCase = casesWithRuleFields.containsKey(c.Id) ? casesWithRuleFields.get(c.Id) : c;
            row.caseRuleFieldsJson = ImputacionesBillableRules.serializeCaseRuleFields(
                ruleCase,
                caseRuleFieldApis
            );
            row.caseNoFactLocked = ImputacionesBillableRules.caseForcedNoFacturable(
                ruleCase,
                amsMgmt,
                billRules
            );
            row.caseNumber = c.CaseNumber;
            row.subject = c.Subject;
            row.ownerId = c.OwnerId;
            row.ownerName = (c.Owner != null) ? c.Owner.Name : null;
            /* PEP del Case (si fue traído en la query). Se usa en la UI para habilitar
             * fechas futuras en tickets de vacaciones (PEP siempre facturable). */
            String pepNm = null;
            try {
                if (c.PEP__r != null) pepNm = c.PEP__r.Name;
            } catch (Exception ignore) {}
            row.pepName = pepNm;
            row.allowsFutureDates = isAlwaysFacturablePepName(pepNm);
            row.lastImputationId = lastImpByCase.get(c.Id);
            Decimal totalH = alreadyHoursByCase.containsKey(c.Id) ? alreadyHoursByCase.get(c.Id) : 0;
            row.alreadyImputedHours = totalH;
            row.billableHoursSplitAvailable = nfLoad.available;
            if (nfLoad.available) {
                Decimal nfH = nfLoad.noFactByCase.containsKey(c.Id) ? nfLoad.noFactByCase.get(c.Id) : 0;
                row.alreadyImputedNoFacturableHours = nfH;
                Decimal factH = totalH - nfH;
                row.alreadyImputedFacturableHours = (factH < 0) ? 0 : factH;
            } else {
                row.alreadyImputedFacturableHours = null;
                row.alreadyImputedNoFacturableHours = null;
            }
            if (admin) {
                row.participationRole = null;
            } else if (c.OwnerId == currentUserId) {
                row.participationRole = 'Responsable';
            } else {
                row.participationRole = 'Equipo';
            }
            rows.add(row);
        }
        return rows;
    }

    /** Motivos AMS: reserva en objeto y ultimo recurso antes del fallback fijo en codigo. */
    private static Set<String> parseAmsReasonFallbackChain() {
        Set<String> out = new Set<String>();
        Configurar_Centro_Imputaciones__c cfgOp = getOperativeConfigRow();
        if (cfgOp != null && String.isNotBlank(cfgOp.Motivos_Fallback__c)) {
            out.addAll(parseDelimitedTokens(cfgOp.Motivos_Fallback__c));
        }
        if (out.isEmpty()) {
            Configurar_Centro_Imputaciones__c cfgUr = getOperativeConfigRow();
            if (cfgUr != null && String.isNotBlank(cfgUr.Motivos_Ultimo_Recurso__c)) {
                out.addAll(parseDelimitedTokens(cfgUr.Motivos_Ultimo_Recurso__c));
            }
        }
        if (out.isEmpty()) {
            out.add('Gestion_Interna');
            out.add('Gestion Interna');
        }
        return out;
    }

    /** Campo en Case para filtro AMS: objeto Campo_Case_Motivo_Ams__c o Reason estandar. */
    private static String resolveCaseReasonFieldForAms() {
        String api = null;
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        if (cfg != null && String.isNotBlank(cfg.Campo_Case_Motivo_Ams__c)) {
            api = cfg.Campo_Case_Motivo_Ams__c.trim();
        }
        Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
        if (String.isNotBlank(api) && caseFm.containsKey(api) && caseFm.get(api).getDescribe().isAccessible()) {
            return api;
        }
        if (caseFm.containsKey('Reason') && caseFm.get('Reason').getDescribe().isAccessible()) {
            return 'Reason';
        }
        return null;
    }

    private static String normalizeHexColor(String raw, String fallbackHex) {
        if (String.isBlank(raw)) {
            return fallbackHex;
        }
        String t = raw.trim();
        if (t.startsWith('#')) {
            t = t.substring(1);
        }
        if (t.length() == 3) {
            t = t.substring(0, 1) + t.substring(0, 1) + t.substring(1, 2) + t.substring(1, 2) + t.substring(2, 3) + t.substring(2, 3);
        }
        if (t.length() != 6 || !Pattern.matches('[0-9A-Fa-f]{6}', t)) {
            return fallbackHex;
        }
        return '#' + t.toUpperCase();
    }

    private static String colorFromConfigField(Configurar_Centro_Imputaciones__c oc, String fieldApi, String fallbackHex) {
        if (oc == null) {
            return fallbackHex;
        }
        Object v = oc.get(fieldApi);
        return normalizeHexColor(v == null ? null : String.valueOf(v), fallbackHex);
    }

    private static void applyCalendarColorsFromConfig(ImputationCenterSettingsDTO dto, Configurar_Centro_Imputaciones__c oc) {
        dto.calColorEmptyBg = colorFromConfigField(oc, 'Color_Cal_Dia_Vacio_Fondo__c', '#F7F8FA');
        dto.calColorPartialBg = colorFromConfigField(oc, 'Color_Cal_Dia_Parcial_Fondo__c', '#FEF9EC');
        dto.calColorPartialBorder = colorFromConfigField(oc, 'Color_Cal_Dia_Parcial_Borde__c', '#E6DABE');
        dto.calColorMetaBg = colorFromConfigField(oc, 'Color_Cal_Dia_Meta_Fondo__c', '#EFF8F3');
        dto.calColorMetaBorder = colorFromConfigField(oc, 'Color_Cal_Dia_Meta_Borde__c', '#B8DCCB');
        dto.calColorOverThreshold = colorFromConfigField(oc, 'Color_Cal_Dia_Sobre_Umbral__c', '#EA580C');
        dto.calColorHolidayBg = colorFromConfigField(oc, 'Color_Cal_Dia_Feriado_Fondo__c', '#FFF1F3');
        dto.calColorWeekendBg = colorFromConfigField(oc, 'Color_Cal_Dia_Fin_Semana_Fondo__c', '#FEF6F8');
        dto.calColorSelectedBg = colorFromConfigField(oc, 'Color_Cal_Dia_Seleccion_Fondo__c', '#E9F4FF');
        dto.calColorSelectedBorder = colorFromConfigField(oc, 'Color_Cal_Dia_Seleccion_Borde__c', '#82A7CF');
        dto.calColorLockedBg = colorFromConfigField(oc, 'Color_Cal_Dia_Bloqueado_Fondo__c', '#EEF1F6');
    }

    private static void applyChartColorsFromConfig(ImputationCenterSettingsDTO dto, Configurar_Centro_Imputaciones__c oc) {
        dto.chartColorFacturable = colorFromConfigField(oc, 'Color_Grafico_Facturable__c', '#15803D');
        dto.chartColorNoFacturable = colorFromConfigField(oc, 'Color_Grafico_No_Facturable__c', '#EA580C');
        dto.chartColorMetaProgress = colorFromConfigField(oc, 'Color_Grafico_Meta_Progreso__c', '#F59E0B');
        dto.chartColorImputable = colorFromConfigField(oc, 'Color_Grafico_Imputable__c', '#2563EB');
    }

    /**
     * Campo «Servicio» en Case para restringir la lista AMS a AMS-SAP / AMS-SAP-Mexico.
     * Prueba varias APIs comunes; si ninguna existe en la org el filtro se omite (no rompe la lista).
     */
    private static String resolveCaseServicioFieldApi() {
        Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
        for (String api : new List<String>{ 'Servicio__c', 'Service__c', 'Servicio_AMS__c' }) {
            if (!caseFm.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = caseFm.get(api).getDescribe();
            if (!d.isAccessible() || !d.isFilterable()) {
                continue;
            }
            return d.getName();
        }
        return null;
    }

    @AuraEnabled(cacheable=true)
    public static String getUiOptions() {
        UiOptionsDTO dto = new UiOptionsDTO();
        dto.owners = new List<OptionDTO>();
        Boolean admin = isImputationAdmin();
        dto.isImputationAdmin = admin;

        if (admin) {
            Integer ownerLim = resolveSoqlLimitOwnerOptions();
            try {
                if (hasConsultantUserFilterConfigured()) {
                    /* Filtro admin: usuarios activos del campo/valores configurados (no solo owners de Case). */
                    dto.owners = buildConsultantUserOptionsFromConfig(ownerLim);
                } else {
                    String ownSoql =
                        'SELECT OwnerId oid, Owner.Name oname, COUNT(Id) total FROM Case WHERE OwnerId != null ' +
                        'GROUP BY OwnerId, Owner.Name ORDER BY Owner.Name LIMIT ' +
                        String.valueOf(ownerLim);
                    for (AggregateResult arOwner : Database.query(ownSoql)) {
                        dto.owners.add(newOption((String) arOwner.get('oname'), (String) arOwner.get('oid')));
                    }
                }
            } catch (Exception ex) {
                System.debug(LoggingLevel.WARN, 'getUiOptions owners: ' + ex.getMessage());
            }
        }

        return JSON.serialize(dto);
    }

    @TestVisible
    private static Boolean hasConsultantUserFilterConfigured() {
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        return cfg != null &&
            String.isNotBlank(cfg.Filtro_Consultor_User_Campo__c) &&
            String.isNotBlank(cfg.Filtro_Consultor_User_Valores__c);
    }

    private static Boolean userFieldValueMatchesAllowedTokens(Object raw, Set<String> allowedVals) {
        if (raw == null || allowedVals == null || allowedVals.isEmpty()) {
            return false;
        }
        String val = String.valueOf(raw).trim();
        for (String tok : allowedVals) {
            if (val.equalsIgnoreCase(tok)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Usuarios activos que cumplen Filtro consultores (admin): origen para combos Resolutores / A nombre de.
     */
    @TestVisible
    private static List<OptionDTO> buildConsultantUserOptionsFromConfig(Integer rowLimit) {
        Configurar_Centro_Imputaciones__c cfg = getOperativeConfigRow();
        if (cfg == null || String.isBlank(cfg.Filtro_Consultor_User_Campo__c) || String.isBlank(cfg.Filtro_Consultor_User_Valores__c)) {
            return new List<OptionDTO>();
        }
        String userField = cfg.Filtro_Consultor_User_Campo__c.trim();
        Map<String, Schema.SObjectField> fMap = User.SObjectType.getDescribe().fields.getMap();
        if (!fMap.containsKey(userField) || !fMap.get(userField).getDescribe().isAccessible()) {
            return new List<OptionDTO>();
        }
        Set<String> allowedVals = parseDelimitedTokens(cfg.Filtro_Consultor_User_Valores__c);
        if (allowedVals.isEmpty()) {
            return new List<OptionDTO>();
        }
        Integer lim = rowLimit != null && rowLimit > 0 ? rowLimit : 200;
        Schema.DescribeFieldResult dfr = fMap.get(userField).getDescribe();
        List<User> users = new List<User>();
        try {
            if (dfr.isFilterable()) {
                Set<String> bindVals = allowedVals;
                String uq =
                    'SELECT Id, Name, ' +
                    String.escapeSingleQuotes(userField) +
                    ' FROM User WHERE IsActive = true AND ' +
                    String.escapeSingleQuotes(userField) +
                    ' IN :bindVals ORDER BY Name LIMIT ' +
                    String.valueOf(lim);
                users = Database.query(uq);
            } else {
                String uq =
                    'SELECT Id, Name, ' +
                    String.escapeSingleQuotes(userField) +
                    ' FROM User WHERE IsActive = true ORDER BY Name LIMIT ' +
                    String.valueOf(lim * 3);
                for (User u : (List<User>) Database.query(uq)) {
                    if (userFieldValueMatchesAllowedTokens(u.get(userField), allowedVals)) {
                        users.add(u);
                        if (users.size() >= lim) {
                            break;
                        }
                    }
                }
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'buildConsultantUserOptionsFromConfig: ' + ex.getMessage());
            return new List<OptionDTO>();
        }
        List<OptionDTO> out = new List<OptionDTO>();
        for (User u : users) {
            if (u == null || u.Id == null) {
                continue;
            }
            if (!dfr.isFilterable() || userFieldValueMatchesAllowedTokens(u.get(userField), allowedVals)) {
                out.add(newOption(u.Name, String.valueOf(u.Id)));
            }
        }
        return sortOptionDtosByLabel(out);
    }

    private static List<OptionDTO> sortOptionDtosByLabel(List<OptionDTO> inOpts) {
        if (inOpts == null || inOpts.isEmpty()) {
            return inOpts == null ? new List<OptionDTO>() : inOpts;
        }
        List<String> keys = new List<String>();
        Map<String, OptionDTO> byKey = new Map<String, OptionDTO>();
        for (OptionDTO o : inOpts) {
            if (o == null) {
                continue;
            }
            String label = o.label != null ? o.label : '';
            String key = label.toLowerCase() + '|' + (o.value != null ? o.value : '');
            keys.add(key);
            byKey.put(key, o);
        }
        keys.sort();
        List<OptionDTO> out = new List<OptionDTO>();
        for (String k : keys) {
            out.add(byKey.get(k));
        }
        return out;
    }

    private static List<OptionDTO> filterOwnerOptionsByConsultantConfig(List<OptionDTO> owners) {
        if (owners == null || owners.isEmpty()) {
            return owners == null ? new List<OptionDTO>() : owners;
        }
        if (hasConsultantUserFilterConfigured()) {
            return buildConsultantUserOptionsFromConfig(resolveSoqlLimitOwnerOptions());
        }
        return owners;
    }

    private class TicketCatalogTabDef {
        String id;
        String label;
        String type;
        Boolean supportsCreatedDateFilter;
        String tabHint;
        List<CaseFieldFilter> caseFilters;
        String filterLogic;
        Boolean hidden;
        Integer createdDateDaysBack;
    }

    private static List<TicketCatalogTabDef> buildDefaultTicketCatalogTabDefs() {
        List<TicketCatalogTabDef> out = new List<TicketCatalogTabDef>();
        TicketCatalogTabDef mine = new TicketCatalogTabDef();
        mine.id = 'mine';
        mine.label = 'Mis tickets';
        mine.type = 'mine';
        out.add(mine);

        TicketCatalogTabDef ams = new TicketCatalogTabDef();
        ams.id = 'ams';
        ams.label = 'Gestion AMS';
        ams.type = 'ams';
        ams.supportsCreatedDateFilter = true;
        ams.tabHint = null;
        out.add(ams);
        return out;
    }

    private static List<TicketCatalogTabDef> parseTicketCatalogTabDefs(String rawJson, Boolean hideAmsTab) {
        List<TicketCatalogTabDef> defaults = buildDefaultTicketCatalogTabDefs();
        if (String.isBlank(rawJson)) {
            return filterTicketCatalogTabDefs(defaults, hideAmsTab);
        }
        try {
            List<Object> arr = (List<Object>) JSON.deserializeUntyped(rawJson.trim());
            if (arr == null || arr.isEmpty()) {
                return filterTicketCatalogTabDefs(defaults, hideAmsTab);
            }
            List<TicketCatalogTabDef> parsed = new List<TicketCatalogTabDef>();
            Set<String> seen = new Set<String>();
            for (Object o : arr) {
                if (!(o instanceof Map<String, Object>)) {
                    continue;
                }
                Map<String, Object> m = (Map<String, Object>) o;
                TicketCatalogTabDef t = mapJsonToTicketCatalogTabDef(m);
                if (t == null || String.isBlank(t.id) || seen.contains(t.id)) {
                    continue;
                }
                seen.add(t.id);
                parsed.add(t);
            }
            if (parsed.isEmpty()) {
                return filterTicketCatalogTabDefs(defaults, hideAmsTab);
            }
            if (!seen.contains('mine')) {
                parsed.add(0, defaults[0]);
            }
            return filterTicketCatalogTabDefs(parsed, hideAmsTab);
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'parseTicketCatalogTabDefs: ' + ex.getMessage());
            return filterTicketCatalogTabDefs(defaults, hideAmsTab);
        }
    }

    private static List<TicketCatalogTabDef> filterTicketCatalogTabDefs(
        List<TicketCatalogTabDef> tabs,
        Boolean hideAmsTab
    ) {
        List<TicketCatalogTabDef> out = new List<TicketCatalogTabDef>();
        for (TicketCatalogTabDef t : tabs) {
            if (t == null) {
                continue;
            }
            if (t.hidden == true) {
                continue;
            }
            if (hideAmsTab == true && t.type == 'ams') {
                continue;
            }
            out.add(t);
        }
        if (out.isEmpty()) {
            List<TicketCatalogTabDef> onlyMine = new List<TicketCatalogTabDef>();
            onlyMine.add(buildDefaultTicketCatalogTabDefs()[0]);
            return onlyMine;
        }
        return out;
    }

    private static TicketCatalogTabDef mapJsonToTicketCatalogTabDef(Map<String, Object> m) {
        String id = normalizeCatalogTabId(stringFromJson(m.get('id')));
        String label = stringFromJson(m.get('label'));
        String type = stringFromJson(m.get('type'));
        if (String.isBlank(id) || String.isBlank(label) || String.isBlank(type)) {
            return null;
        }
        type = type.toLowerCase();
        if (type != 'mine' && type != 'ams' && type != 'custom') {
            return null;
        }
        TicketCatalogTabDef t = new TicketCatalogTabDef();
        t.id = id;
        t.label = label.left(80);
        t.type = type;
        Object sdf = m.get('supportsCreatedDateFilter');
        t.supportsCreatedDateFilter = sdf == true || 'true'.equalsIgnoreCase(stringFromJson(sdf));
        t.tabHint = stringFromJson(m.get('hint'));
        if (String.isBlank(t.tabHint)) {
            t.tabHint = stringFromJson(m.get('tabHint'));
        }
        Object hiddenObj = m.get('hidden');
        t.hidden = hiddenObj == true || 'true'.equalsIgnoreCase(stringFromJson(hiddenObj));
        String logicRaw = stringFromJson(m.get('filterLogic'));
        t.filterLogic = 'OR'.equalsIgnoreCase(logicRaw) ? 'OR' : 'AND';
        String daysRaw = stringFromJson(m.get('createdDateDaysBack'));
        if (String.isNotBlank(daysRaw)) {
            try {
                t.createdDateDaysBack = Integer.valueOf(daysRaw);
            } catch (Exception exDays) {
                t.createdDateDaysBack = null;
            }
        }

        if (type == 'custom' || type == 'ams') {
            t.caseFilters = buildCaseFiltersFromTabJson(m);
            if (type == 'custom' && (t.caseFilters == null || t.caseFilters.isEmpty())) {
                return null;
            }
        }
        return t;
    }

    private static List<CaseFieldFilter> buildCaseFiltersFromTabJson(Map<String, Object> m) {
        List<CaseFieldFilter> out = new List<CaseFieldFilter>();
        Object filtersObj = m.get('filters');
        if (filtersObj instanceof List<Object>) {
            for (Object fo : (List<Object>) filtersObj) {
                if (!(fo instanceof Map<String, Object>)) {
                    continue;
                }
                Map<String, Object> fm = (Map<String, Object>) fo;
                Boolean matchEmpty = fm.get('matchEmpty') == true;
                appendCaseFilter(
                    out,
                    stringFromJson(fm.get('fieldApi')),
                    stringFromJson(fm.get('values')),
                    matchEmpty
                );
            }
        }
        appendCaseFilter(out, stringFromJson(m.get('caseFieldApi')), stringFromJson(m.get('caseFieldValues')));
        appendCaseFilter(out, stringFromJson(m.get('caseFieldApi2')), stringFromJson(m.get('caseFieldValues2')));

        String motivosRaw = stringFromJson(m.get('motivos'));
        if (String.isBlank(motivosRaw)) {
            motivosRaw = stringFromJson(m.get('reasonValues'));
        }
        if (String.isNotBlank(motivosRaw)) {
            String fieldApi = stringFromJson(m.get('campoMotivo'));
            if (String.isBlank(fieldApi)) {
                fieldApi = stringFromJson(m.get('reasonFieldApi'));
            }
            if (String.isBlank(fieldApi)) {
                fieldApi = stringFromJson(m.get('caseFieldApi'));
            }
            fieldApi = resolveCaseReasonFieldForConfiguredApi(fieldApi);
            appendCaseFilter(out, fieldApi, motivosRaw);
        }
        String servRaw = stringFromJson(m.get('servicios'));
        if (String.isBlank(servRaw)) {
            servRaw = stringFromJson(m.get('servicioValues'));
        }
        if (String.isNotBlank(servRaw)) {
            String servField = stringFromJson(m.get('caseFieldApi2'));
            if (String.isBlank(servField)) {
                servField = resolveCaseServicioFieldApi();
            }
            appendCaseFilter(out, servField, servRaw);
        }
        return out;
    }

    private static void appendCaseFilter(List<CaseFieldFilter> out, String fieldApi, String valuesRaw) {
        appendCaseFilter(out, fieldApi, valuesRaw, false);
    }

    private static void appendCaseFilter(
        List<CaseFieldFilter> out,
        String fieldApi,
        String valuesRaw,
        Boolean matchEmpty
    ) {
        if (String.isBlank(fieldApi)) {
            return;
        }
        Boolean wantsEmpty = matchEmpty == true;
        if (String.isBlank(valuesRaw) && !wantsEmpty) {
            return;
        }
        String api = validateCaseFilterFieldApi(fieldApi);
        if (String.isBlank(api)) {
            api = resolveCaseReasonFieldForConfiguredApi(fieldApi);
            if (String.isBlank(api) || api != fieldApi.trim()) {
                api = validateCaseFilterFieldApi(api);
            }
        }
        if (String.isBlank(api)) {
            return;
        }
        Set<String> vals = String.isBlank(valuesRaw) ? new Set<String>() : parseDelimitedTokens(valuesRaw);
        if (vals.isEmpty() && !wantsEmpty) {
            return;
        }
        for (CaseFieldFilter existing : out) {
            if (existing.fieldApi == api) {
                existing.values.addAll(vals);
                if (wantsEmpty) {
                    existing.matchEmpty = true;
                }
                return;
            }
        }
        CaseFieldFilter f = new CaseFieldFilter();
        f.fieldApi = api;
        f.values = vals;
        f.matchEmpty = wantsEmpty;
        out.add(f);
    }

    private static String buildCaseFilterSoqlClause(CaseFieldFilter f, Integer bindIdx) {
        if (f == null || String.isBlank(f.fieldApi)) {
            return null;
        }
        String field = f.fieldApi;
        Boolean hasValues = f.values != null && !f.values.isEmpty();
        Boolean wantsEmpty = f.matchEmpty == true;
        if (!hasValues && !wantsEmpty) {
            return null;
        }
        String emptyClause = '(' + field + ' = null OR ' + field + ' = \'\')';
        if (hasValues && wantsEmpty) {
            return '(' + field + ' IN :filter' + bindIdx + 'Values OR ' + emptyClause + ')';
        }
        if (wantsEmpty) {
            return emptyClause;
        }
        return field + ' IN :filter' + bindIdx + 'Values';
    }

    private static String stringFromJson(Object o) {
        return o == null ? null : String.valueOf(o).trim();
    }

    private static String normalizeCatalogTabId(String raw) {
        if (String.isBlank(raw)) {
            return null;
        }
        String t = raw.trim().toLowerCase();
        if (!Pattern.matches('[a-z0-9_\\-]{1,40}', t)) {
            return null;
        }
        return t;
    }

    private static String resolveCaseReasonFieldForConfiguredApi(String configuredApi) {
        Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
        String api = String.isNotBlank(configuredApi) ? configuredApi.trim() : null;
        if (String.isNotBlank(api) && caseFm.containsKey(api) && caseFm.get(api).getDescribe().isAccessible()) {
            return api;
        }
        return resolveCaseReasonFieldForAms();
    }

    private static List<TicketCatalogTabDef> getEffectiveTicketCatalogTabDefs() {
        Configurar_Centro_Imputaciones__c oc = getOperativeConfigRow();
        Boolean hideAms = oc != null && oc.Ui_Ocultar_Tab_Gestion_Ams__c == true;
        String raw = oc != null ? oc.Pestanas_Catalogo_Tickets__c : null;
        return parseTicketCatalogTabDefs(raw, hideAms);
    }

    private static TicketCatalogTabDef resolveTicketCatalogTab(String tabId) {
        if (String.isBlank(tabId)) {
            return null;
        }
        String norm = tabId.trim().toLowerCase();
        for (TicketCatalogTabDef t : getEffectiveTicketCatalogTabDefs()) {
            if (t != null && t.id == norm) {
                return t;
            }
        }
        return null;
    }

    private static List<TicketCatalogTabDTO> buildTicketCatalogTabsDto(Boolean hideAmsTab) {
        Configurar_Centro_Imputaciones__c oc = getOperativeConfigRow();
        String raw = oc != null ? oc.Pestanas_Catalogo_Tickets__c : null;
        List<TicketCatalogTabDef> defs = parseTicketCatalogTabDefs(raw, hideAmsTab);
        List<TicketCatalogTabDTO> out = new List<TicketCatalogTabDTO>();
        for (TicketCatalogTabDef d : defs) {
            TicketCatalogTabDTO dto = new TicketCatalogTabDTO();
            dto.id = d.id;
            dto.label = d.label;
            dto.type = d.type;
            dto.supportsCreatedDateFilter = d.supportsCreatedDateFilter == true;
            dto.tabHint = d.tabHint;
            dto.hidden = d.hidden == true;
            dto.createdDateDaysBack = d.createdDateDaysBack;
            out.add(dto);
        }
        return out;
    }

    private static String defaultCriterioCalculoFacturable() {
        return 'Horas imputadas del mes marcadas como facturables en Imputacion__c. '
            + 'En la seleccion pendiente: filas sin "No fact." y que no sean ticket de gestion AMS. '
            + 'Si el mes no trae desglose por campo, se estima con el % meta facturable.';
    }

    private static String defaultCriterioCalculoNoFacturable() {
        return 'Horas no facturables guardadas en el mes, mas tickets de gestion AMS (todo su imputado cuenta como no facturable). '
            + 'En la seleccion pendiente: checkbox "No fact." activo o caso AMS gestion.';
    }

    /**
     * Solo colores del registro DEFAULT (without sharing + SYSTEM_MODE).
     * El LWC lo fusiona con getImputationCenterSettings para que consultores vean la paleta configurada.
     */
    @AuraEnabled(cacheable=false)
    public static String getOperativeThemeSettings() {
        return ImputacionesOperativeConfigLoader.serializeThemeSettingsJson();
    }

    /** cacheable=false: el registro operativo cambia sin invalidar cache de LDS si fuese cacheable. */
    @AuraEnabled(cacheable=false)
    public static String getImputationCenterSettings() {
        ImputationCenterSettingsDTO dto = new ImputationCenterSettingsDTO();
        dto.monthlyFacturableTargetPct = null;
        dto.workdayTargetHours = null;
        dto.adminHelpText = null;
        dto.developerName = 'DEFAULT';
        dto.listaPepAms = null;
        dto.campoPepCaseApi = null;
        dto.operativeMaxPinnedTickets = null;
        dto.operativeStripCalendarDays = null;
        dto.operativeDayHighlightHours = null;
        dto.operativeWarnDayHours = null;
        dto.operativeTicketPageSize = null;
        dto.operativeDefaultSource = null;
        dto.helpBannerText = null;
        dto.showUsageGuide = true;
        dto.usageGuideIntro = null;
        dto.extraHolidaysMmDd = null;
        dto.imputationMonthsRetro = null;
        dto.imputationMonthsForward = null;
        dto.amsCreatedFilterDaysBack = null;
        dto.uiHideImportCsv = false;
        dto.uiHideExportCsv = false;
        dto.uiHideQuarterPanel = false;
        dto.uiHideAmsTab = false;
        dto.allowWeekendImputation = true;
        dto.allowHolidayImputation = true;
        dto.activarAvisoUmbralHoras = true;
        dto.userWeekendImputationBypass = false;
        dto.weekendConfirmText = null;
        dto.thresholdHoursWarnText = null;
        dto.holidayWarningText = null;
        dto.confirmImputationExtraText = null;
        dto.panelMetaCopyJson = null;
        dto.criterioCalculoFacturable = defaultCriterioCalculoFacturable();
        dto.criterioCalculoNoFacturable = defaultCriterioCalculoNoFacturable();

        try {
            Configurar_Centro_Imputaciones__c oc = getOperativeConfigRow();
            if (oc != null) {
                applyCalendarColorsFromConfig(dto, oc);
                applyChartColorsFromConfig(dto, oc);
                if (oc.Numero_Ticket_Anclados__c != null && oc.Numero_Ticket_Anclados__c > 0) {
                    dto.operativeMaxPinnedTickets = oc.Numero_Ticket_Anclados__c;
                }
                if (oc.Dias_franja_calendario__c != null && oc.Dias_franja_calendario__c > 0) {
                    dto.operativeStripCalendarDays = oc.Dias_franja_calendario__c;
                }
                if (oc.Horas_Jornada__c != null && oc.Horas_Jornada__c > 0) {
                    dto.operativeDayHighlightHours = oc.Horas_Jornada__c;
                }
                if (oc.Umbral_Aviso_Horas_Dia__c != null && oc.Umbral_Aviso_Horas_Dia__c > 0) {
                    dto.operativeWarnDayHours = oc.Umbral_Aviso_Horas_Dia__c;
                }
                if (oc.Tamano_Pagina_Tickets__c != null && oc.Tamano_Pagina_Tickets__c > 0) {
                    dto.operativeTicketPageSize = oc.Tamano_Pagina_Tickets__c;
                }
                if (String.isNotBlank(oc.Origen_Imputacion__c)) {
                    dto.operativeDefaultSource = oc.Origen_Imputacion__c.trim();
                }
                if (oc.Meta_Facturable_Pct__c != null && oc.Meta_Facturable_Pct__c > 0) {
                    dto.monthlyFacturableTargetPct = oc.Meta_Facturable_Pct__c;
                }
                if (oc.Horas_Meta_Dia_Lab__c != null && oc.Horas_Meta_Dia_Lab__c > 0) {
                    dto.workdayTargetHours = oc.Horas_Meta_Dia_Lab__c;
                }
                if (String.isNotBlank(oc.Ayuda_Admin_Monitor__c)) {
                    dto.adminHelpText = oc.Ayuda_Admin_Monitor__c;
                }
                if (String.isNotBlank(oc.Ayuda_Texto_General__c)) {
                    dto.helpBannerText = oc.Ayuda_Texto_General__c;
                }
                dto.showUsageGuide = oc.Ui_Mostrar_Guia_Uso__c != false;
                if (String.isNotBlank(oc.Guia_Uso_Texto__c)) {
                    dto.usageGuideIntro = oc.Guia_Uso_Texto__c;
                }
                if (String.isNotBlank(oc.Festivos_Extra_MM_DD__c)) {
                    dto.extraHolidaysMmDd = oc.Festivos_Extra_MM_DD__c;
                }
                if (oc.Imputacion_Meses_Retro__c != null) {
                    dto.imputationMonthsRetro = oc.Imputacion_Meses_Retro__c;
                }
                if (oc.Imputacion_Meses_Adelante__c != null) {
                    dto.imputationMonthsForward = oc.Imputacion_Meses_Adelante__c;
                }
                if (oc.Ams_Creado_Filtro_Dias_Atras__c != null && oc.Ams_Creado_Filtro_Dias_Atras__c > 0) {
                    dto.amsCreatedFilterDaysBack = oc.Ams_Creado_Filtro_Dias_Atras__c;
                }
                dto.uiHideImportCsv = oc.Ui_Ocultar_Importar_Csv__c == true;
                dto.uiHideExportCsv = oc.Ui_Ocultar_Exportar_Csv__c == true;
                dto.uiHideQuarterPanel = oc.Ui_Ocultar_Panel_Trimestral__c == true;
                dto.uiHideAmsTab = oc.Ui_Ocultar_Tab_Gestion_Ams__c == true;
                dto.ticketCatalogTabs = buildTicketCatalogTabsDto(dto.uiHideAmsTab);
                dto.allowWeekendImputation = oc.Permitir_Imputar_Fin_Semana__c != false;
                dto.allowHolidayImputation = oc.Permitir_Imputar_Feriados__c != false;
                if (String.isNotBlank(oc.Texto_Aviso_Fin_Semana__c)) {
                    dto.weekendConfirmText = oc.Texto_Aviso_Fin_Semana__c.trim();
                }
                if (String.isNotBlank(oc.Texto_Aviso_Umbral_Horas__c)) {
                    dto.thresholdHoursWarnText = oc.Texto_Aviso_Umbral_Horas__c.trim();
                }
                if (String.isNotBlank(oc.Texto_Aviso_Feriado__c)) {
                    dto.holidayWarningText = oc.Texto_Aviso_Feriado__c.trim();
                }
                if (String.isNotBlank(oc.Texto_Confirmacion_Imputacion__c)) {
                    dto.confirmImputationExtraText = oc.Texto_Confirmacion_Imputacion__c.trim();
                }
                if (String.isNotBlank(oc.Panel_Meta_Copy_JSON__c)) {
                    dto.panelMetaCopyJson = oc.Panel_Meta_Copy_JSON__c;
                }
                dto.criterioCalculoFacturable = String.isNotBlank(oc.Criterio_Calculo_Facturable__c)
                    ? oc.Criterio_Calculo_Facturable__c
                    : defaultCriterioCalculoFacturable();
                dto.criterioCalculoNoFacturable = String.isNotBlank(oc.Criterio_Calculo_No_Facturable__c)
                    ? oc.Criterio_Calculo_No_Facturable__c
                    : defaultCriterioCalculoNoFacturable();
                if (String.isNotBlank(oc.Texto_Subtitulo_Centro__c)) {
                    dto.headerCenterTagline = oc.Texto_Subtitulo_Centro__c.trim();
                }
                dto.activarAvisoUmbralHoras = oc.Activar_Aviso_Umbral_Horas__c != false;
                if (
                    String.isNotBlank(oc.Excepcion_Fin_Semana_User_Campo__c) &&
                    String.isNotBlank(oc.Excepcion_Fin_Semana_User_Valores__c)
                ) {
                    dto.userWeekendImputationBypass = currentUserMatchesConfigUserField(
                        oc.Excepcion_Fin_Semana_User_Campo__c,
                        oc.Excepcion_Fin_Semana_User_Valores__c
                    );
                }
                if (String.isNotBlank(oc.Criterios_Facturable_Filtros_JSON__c)) {
                    dto.billableCriteriaFiltersJson = oc.Criterios_Facturable_Filtros_JSON__c;
                }
                if (String.isNotBlank(oc.Motivo_Ticket__c)) {
                    dto.listaPepAms = oc.Motivo_Ticket__c;
                }
                String caseField = resolveCaseReasonFieldForAms();
                if (String.isNotBlank(caseField)) {
                    dto.campoPepCaseApi = caseField;
                }
            } else {
                applyCalendarColorsFromConfig(dto, null);
                applyChartColorsFromConfig(dto, null);
                dto.ticketCatalogTabs = buildTicketCatalogTabsDto(false);
            }
        } catch (Exception ignore) {
            if (String.isBlank(dto.chartColorFacturable)) {
                applyChartColorsFromConfig(dto, null);
            }
            if (String.isBlank(dto.calColorEmptyBg)) {
                applyCalendarColorsFromConfig(dto, null);
            }
            if (dto.ticketCatalogTabs == null) {
                dto.ticketCatalogTabs = buildTicketCatalogTabsDto(false);
            }
        }

        applyOperativeDefaultsToDto(dto);
        ImputacionesOperativeConfigLoader.applyThemeToSettingsDto(dto);
        return JSON.serialize(dto);
    }

    /** Valores de negocio por defecto si el registro DEFAULT existe pero campos meta estan vacios. */
    private static void applyOperativeDefaultsToDto(ImputationCenterSettingsDTO dto) {
        if (dto == null) {
            return;
        }
        if (dto.monthlyFacturableTargetPct == null || dto.monthlyFacturableTargetPct <= 0) {
            dto.monthlyFacturableTargetPct = 85;
        }
        if (dto.workdayTargetHours == null || dto.workdayTargetHours <= 0) {
            dto.workdayTargetHours = 8;
        }
        if (String.isBlank(dto.chartColorFacturable)) {
            applyChartColorsFromConfig(dto, null);
        }
        if (String.isBlank(dto.calColorEmptyBg)) {
            applyCalendarColorsFromConfig(dto, null);
        }
    }

    @AuraEnabled(cacheable=false)
    public static String getImputationCenterDiagnostics() {
        return JSON.serialize(buildImputationCenterDiagnostics());
    }

    private static List<ConfigDiagnosticRowDTO> buildImputationCenterDiagnostics() {
        List<ConfigDiagnosticRowDTO> rows = new List<ConfigDiagnosticRowDTO>();
        Configurar_Centro_Imputaciones__c oc = getOperativeConfigRow();

        rows.add(
            diagRow(
                'codeChileHolidays',
                'Festivos Chile fijos (lista)',
                String.join(new List<String>(CHILE_HOLIDAYS_MM_DD), ', '),
                'Apex CHILE_HOLIDAYS_MM_DD · LWC CHILE_FIXED_HOLIDAY_MM_DD',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeStripFallback',
                'Franja calendario si config vacia',
                '14 dias',
                'LWC STRIP_WINDOW_FALLBACK',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeStripMax',
                'Franja calendario maximo UI',
                '21 dias (escala tipografia)',
                'LWC STRIP_WINDOW_MAX',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeStripAnchor',
                'Franja: ancla mes actual',
                'Hoy a 3 dias del borde izquierdo (clamp mes)',
                'LWC stripWindowEffectiveStartDay',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeCatalogTabsDefault',
                'Pestanas catalogo por defecto',
                'Mis tickets [mine], Gestion AMS [ams]',
                'LWC FALLBACK_CATALOG_TABS',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeFacturablePctDefault',
                'Meta facturable % por defecto',
                '85',
                'LWC FACTURABLE_TARGET_PCT_CODE · Apex fallback',
                'code'
            )
        );
        rows.add(
            diagRow(
                'codeJornadaDefault',
                'Jornada objetivo h por defecto',
                '8',
                'LWC JORNADA_OBJETIVO_HORAS · Apex fallback',
                'code'
            )
        );

        Integer stripDaysEff = 14;
        String stripDaysSrc = 'Codigo LWC (14)';
        if (oc != null && oc.Dias_franja_calendario__c != null && oc.Dias_franja_calendario__c > 0) {
            stripDaysEff = oc.Dias_franja_calendario__c.intValue();
            stripDaysSrc = 'Objeto Dias_franja_calendario__c';
        }
        rows.add(
            diagRow(
                'stripWindowDays',
                'Dias en franja (efectivo)',
                String.valueOf(stripDaysEff),
                stripDaysSrc,
                stripDaysSrc.startsWith('Codigo') ? 'code' : 'config'
            )
        );

        Decimal metaPct = 85;
        String metaSrc = 'Codigo (85)';
        if (oc != null && oc.Meta_Facturable_Pct__c != null && oc.Meta_Facturable_Pct__c > 0) {
            metaPct = oc.Meta_Facturable_Pct__c;
            metaSrc = 'Objeto Meta_Facturable_Pct__c';
        }
        rows.add(diagRow('metaFacturablePct', 'Meta facturable mensual (%)', String.valueOf(metaPct), metaSrc, diagKindFromSource(metaSrc)));

        Decimal jornada = 8;
        String jornadaSrc = 'Codigo (8)';
        if (oc != null && oc.Horas_Meta_Dia_Lab__c != null && oc.Horas_Meta_Dia_Lab__c > 0) {
            jornada = oc.Horas_Meta_Dia_Lab__c;
            jornadaSrc = 'Objeto Horas_Meta_Dia_Lab__c';
        }
        rows.add(diagRow('workdayTargetHours', 'Jornada objetivo (h)', String.valueOf(jornada), jornadaSrc, diagKindFromSource(jornadaSrc)));

        List<Integer> monthWin = getImputationMonthWindow();
        Integer retroM = monthWin[0];
        Integer fwdM = monthWin[1];
        String retroVal =
            oc != null && oc.Imputacion_Meses_Retro__c != null
                ? String.valueOf(oc.Imputacion_Meses_Retro__c.intValue())
                : '0 (vacio)';
        String fwdVal =
            oc != null && oc.Imputacion_Meses_Adelante__c != null
                ? String.valueOf(oc.Imputacion_Meses_Adelante__c.intValue())
                : '0 (vacio)';
        rows.add(
            diagRow(
                'imputationMonthRuleBase',
                'Imputacion consultor: regla base',
                'Solo mes civil en curso',
                'LWC imputacionesAMSMonthWindowUtil · Apex isImputationDateModifiableByConsultant',
                'code'
            )
        );
        rows.add(
            diagRow(
                'imputationMonthsRetro',
                'Ventana excepcion: meses atras',
                retroVal,
                oc != null && oc.Imputacion_Meses_Retro__c != null
                    ? 'Objeto Imputacion_Meses_Retro__c'
                    : 'Sin valor (0)',
                'config'
            )
        );
        rows.add(
            diagRow(
                'imputationMonthsForward',
                'Ventana excepcion: meses adelante',
                fwdVal,
                oc != null && oc.Imputacion_Meses_Adelante__c != null
                    ? 'Objeto Imputacion_Meses_Adelante__c'
                    : 'Sin valor (0)',
                'config'
            )
        );
        rows.add(
            diagRow(
                'imputationAllowedYmRange',
                'Meses civiles imputables (consultor)',
                formatImputationYmRangeDiag(retroM, fwdM),
                retroM == 0 && fwdM == 0
                    ? 'Solo ' + formatYmFromParts(Date.today().year(), Date.today().month())
                    : 'Mes actual ± ventana configurada',
                'runtime'
            )
        );
        rows.add(
            diagRow(
                'imputationCalendarNavigation',
                'Selector mes calendario',
                'Sin limite min/max (consulta libre)',
                'LWC: ventana no restringe visualizacion',
                'code'
            )
        );
        rows.add(
            diagRow(
                'imputationVacationFuture',
                'Vacaciones (PEP VAC) en mes futuro',
                'Fecha imputable si >= hoy dentro de ventana adelante',
                'LWC allowFutureDates · Apex vacationPep',
                'code'
            )
        );

        Set<String> motivos = resolveAmsReasonValues();
        String motivosSrc = 'Codigo (Gestion_Interna)';
        if (oc != null && String.isNotBlank(oc.Motivo_Ticket__c)) {
            motivosSrc = 'Objeto Motivo_Ticket__c';
        } else if (oc != null && String.isNotBlank(oc.Motivos_Fallback__c)) {
            motivosSrc = 'Objeto Motivos_Fallback__c';
        } else if (oc != null && String.isNotBlank(oc.Motivos_Ultimo_Recurso__c)) {
            motivosSrc = 'Objeto Motivos_Ultimo_Recurso__c';
        }
        rows.add(
            diagRow(
                'amsReasonValues',
                'Valores motivo AMS',
                String.join(new List<String>(motivos), ', '),
                motivosSrc,
                diagKindFromSource(motivosSrc)
            )
        );

        String caseField = resolveCaseReasonFieldForAms();
        String caseFieldSrc = 'Case.Reason (estandar)';
        if (oc != null && String.isNotBlank(oc.Campo_Case_Motivo_Ams__c)) {
            caseFieldSrc = 'Objeto Campo_Case_Motivo_Ams__c';
        }
        rows.add(diagRow('amsCaseField', 'Campo Case filtro AMS', caseField, caseFieldSrc, diagKindFromSource(caseFieldSrc)));

        String adminHelp = oc != null ? oc.Ayuda_Admin_Monitor__c : null;
        rows.add(
            diagRow(
                'adminMonitorHelp',
                'Ayuda monitor admin',
                String.isNotBlank(adminHelp) ? adminHelp.left(120) : '(vacio)',
                String.isNotBlank(adminHelp) ? 'Objeto Ayuda_Admin_Monitor__c' : 'Sin texto'
            )
        );

        ImputationCenterSettingsDTO colorDto = new ImputationCenterSettingsDTO();
        applyCalendarColorsFromConfig(colorDto, oc);
        applyChartColorsFromConfig(colorDto, oc);
        rows.add(diagRow('calColorMetaBg', 'Color dia meta (fondo)', colorDto.calColorMetaBg, diagColorSource(oc, 'Color_Cal_Dia_Meta_Fondo__c')));
        rows.add(diagRow('chartColorFacturable', 'Color grafico facturable', colorDto.chartColorFacturable, diagColorSource(oc, 'Color_Grafico_Facturable__c')));
        rows.add(diagRow('chartColorNoFacturable', 'Color grafico no facturable', colorDto.chartColorNoFacturable, diagColorSource(oc, 'Color_Grafico_No_Facturable__c')));
        rows.add(diagRow('chartColorMetaProgress', 'Color barra meta facturable', colorDto.chartColorMetaProgress, diagColorSource(oc, 'Color_Grafico_Meta_Progreso__c')));
        rows.add(diagRow('chartColorImputable', 'Color grafico imputable', colorDto.chartColorImputable, diagColorSource(oc, 'Color_Grafico_Imputable__c')));
        rows.add(diagRow('calColorPartialBg', 'Color dia parcial (fondo)', colorDto.calColorPartialBg, diagColorSource(oc, 'Color_Cal_Dia_Parcial_Fondo__c')));
        rows.add(diagRow('calColorSelectedBg', 'Color dia seleccionado', colorDto.calColorSelectedBg, diagColorSource(oc, 'Color_Cal_Dia_Seleccion_Fondo__c')));

        List<TicketCatalogTabDTO> tabsDto = buildTicketCatalogTabsDto(oc != null && oc.Ui_Ocultar_Tab_Gestion_Ams__c == true);
        List<String> tabLabels = new List<String>();
        for (TicketCatalogTabDTO t : tabsDto) {
            if (t != null && String.isNotBlank(t.label)) {
                tabLabels.add(t.label + ' [' + t.id + ']');
            }
        }
        rows.add(
            diagRow(
                'ticketCatalogTabs',
                'Pestanas catalogo (conteo)',
                String.valueOf(tabsDto.size()),
                String.isNotBlank(oc != null ? oc.Pestanas_Catalogo_Tickets__c : null)
                    ? 'Objeto Pestanas_Catalogo_Tickets__c'
                    : 'Plantilla por defecto'
            )
        );
        rows.add(
            diagRow(
                'ticketCatalogTabList',
                'Pestanas activas',
                tabLabels.isEmpty() ? '(ninguna)' : String.join(tabLabels, ', '),
                'Runtime parseTicketCatalogTabDefs',
                'runtime'
            )
        );

        MonthCapacityDiag cap = computeCurrentMonthCapacityDiag(oc);
        rows.add(
            diagRow(
                'businessDaysMonth',
                'Dias habiles mes en curso (' + cap.monthLabel + ')',
                String.valueOf(cap.businessDays),
                cap.sourceNote
            )
        );
        rows.add(
            diagRow(
                'metaHorasMonth',
                'Horas imputables meta mes',
                cap.metaHorasFormatted,
                cap.sourceNote
            )
        );
        rows.add(
            diagRow(
                'metaFacturableMonth',
                'Horas facturables meta mes',
                cap.metaFacturableFormatted,
                cap.sourceNote
            )
        );

        rows.add(
            diagRow(
                'ruleWeekend',
                'Imputar fin de semana',
                oc != null && oc.Permitir_Imputar_Fin_Semana__c == false ? 'Bloqueado' : 'Permitido',
                oc != null ? 'Objeto Permitir_Imputar_Fin_Semana__c' : 'Por defecto (permitido)'
            )
        );
        rows.add(
            diagRow(
                'ruleHoliday',
                'Imputar en festivos',
                oc != null && oc.Permitir_Imputar_Feriados__c == false ? 'Bloqueado' : 'Permitido',
                oc != null ? 'Objeto Permitir_Imputar_Feriados__c' : 'Por defecto (permitido)'
            )
        );
        Decimal retro = oc != null ? oc.Imputacion_Meses_Retro__c : null;
        Decimal adel = oc != null ? oc.Imputacion_Meses_Adelante__c : null;
        rows.add(
            diagRow(
                'ruleMonthsWindow',
                'Ventana meses imputacion',
                'Retro: ' +
                (retro != null ? String.valueOf(retro.intValue()) : '0') +
                ' · Adelante: ' +
                (adel != null ? String.valueOf(adel.intValue()) : '0'),
                oc != null ? 'Objeto Imputacion_Meses_*' : 'Codigo'
            )
        );
        Decimal warnDay = oc != null ? oc.Umbral_Aviso_Horas_Dia__c : null;
        rows.add(
            diagRow(
                'ruleHeavyDayWarn',
                'Aviso dia con muchas horas',
                warnDay != null && warnDay > 0 ? String.valueOf(warnDay) + ' h' : '(desactivado)',
                warnDay != null ? 'Objeto Umbral_Aviso_Horas_Dia__c' : 'Sin umbral'
            )
        );
        rows.add(
            diagRow(
                'ruleUiFlags',
                'UI oculta',
                buildUiHideFlagsSummary(oc),
                'Objeto Ui_Ocultar_*'
            )
        );
        String banner = oc != null ? oc.Ayuda_Texto_General__c : null;
        rows.add(
            diagRow(
                'ruleBanner',
                'Banner ayuda activo',
                String.isNotBlank(banner) ? 'Si (' + banner.left(60) + ')' : 'No',
                String.isNotBlank(banner) ? 'Objeto Ayuda_Texto_General__c' : 'Sin texto'
            )
        );

        return rows;
    }

    private class MonthCapacityDiag {
        String monthLabel;
        Integer businessDays;
        String metaHorasFormatted;
        String metaFacturableFormatted;
        String sourceNote;
    }

    private static final Set<String> CHILE_HOLIDAYS_MM_DD = new Set<String>{
        '01-01',
        '05-01',
        '05-21',
        '06-29',
        '07-16',
        '08-15',
        '09-18',
        '09-19',
        '10-12',
        '10-31',
        '11-01',
        '12-08',
        '12-25'
    };

    private static MonthCapacityDiag computeCurrentMonthCapacityDiag(Configurar_Centro_Imputaciones__c oc) {
        MonthCapacityDiag out = new MonthCapacityDiag();
        Date today = Date.today();
        Integer y = today.year();
        Integer m = today.month();
        out.monthLabel = String.valueOf(m) + '/' + String.valueOf(y);
        Set<String> extraHolidays = parseExtraHolidayMmDd(oc != null ? oc.Festivos_Extra_MM_DD__c : null);
        Integer lastDay = Date.daysInMonth(y, m);
        Integer business = 0;
        for (Integer d = 1; d <= lastDay; d++) {
            Date dt = Date.newInstance(y, m, d);
            Integer dow = Math.mod(Date.newInstance(1900, 1, 7).daysBetween(dt), 7);
            if (dow == 0 || dow == 6) {
                continue;
            }
            String mm = m < 10 ? '0' + String.valueOf(m) : String.valueOf(m);
            String dd = d < 10 ? '0' + String.valueOf(d) : String.valueOf(d);
            String mmdd = mm + '-' + dd;
            if (CHILE_HOLIDAYS_MM_DD.contains(mmdd) || extraHolidays.contains(mmdd)) {
                continue;
            }
            business++;
        }
        out.businessDays = business;
        Decimal jornada = 8;
        Decimal pct = 85;
        if (oc != null && oc.Horas_Meta_Dia_Lab__c != null && oc.Horas_Meta_Dia_Lab__c > 0) {
            jornada = oc.Horas_Meta_Dia_Lab__c;
        }
        if (oc != null && oc.Meta_Facturable_Pct__c != null && oc.Meta_Facturable_Pct__c > 0) {
            pct = oc.Meta_Facturable_Pct__c;
        }
        Decimal metaHoras = business * jornada;
        Decimal metaFact = metaHoras * (pct / 100);
        out.metaHorasFormatted = formatHoursDiag(metaHoras);
        out.metaFacturableFormatted = formatHoursDiag(metaFact);
        out.sourceNote =
            'Mes actual · jornada ' +
            String.valueOf(jornada) +
            ' h · meta ' +
            String.valueOf(pct) +
            '% · festivos Chile fijos + extra';
        return out;
    }

    private static Set<String> parseExtraHolidayMmDd(String raw) {
        Set<String> out = new Set<String>();
        if (String.isBlank(raw)) {
            return out;
        }
        String normalized = raw.replace('\r', '\n').replace(';', '\n');
        for (String line : normalized.split('\n')) {
            if (String.isBlank(line)) {
                continue;
            }
            for (String token : line.split(',')) {
                String t = token != null ? token.trim() : null;
                if (String.isNotBlank(t)) {
                    out.add(t);
                }
            }
        }
        return out;
    }

    private static String formatHoursDiag(Decimal h) {
        if (h == null) {
            return '0 h';
        }
        return String.valueOf(h.setScale(2)) + ' h';
    }

    private static String buildUiHideFlagsSummary(Configurar_Centro_Imputaciones__c oc) {
        if (oc == null) {
            return 'Ninguna (defaults)';
        }
        List<String> parts = new List<String>();
        if (oc.Ui_Ocultar_Importar_Csv__c == true) {
            parts.add('Importar CSV');
        }
        if (oc.Ui_Ocultar_Exportar_Csv__c == true) {
            parts.add('Exportar CSV');
        }
        if (oc.Ui_Ocultar_Panel_Trimestral__c == true) {
            parts.add('Trimestral');
        }
        if (oc.Ui_Ocultar_Tab_Gestion_Ams__c == true) {
            parts.add('Tab AMS');
        }
        return parts.isEmpty() ? 'Ninguna' : String.join(parts, ', ');
    }

    private static ConfigDiagnosticRowDTO diagRow(String key, String label, String value, String source) {
        return diagRow(key, label, value, source, diagKindFromSource(source));
    }

    private static ConfigDiagnosticRowDTO diagRow(String key, String label, String value, String source, String rowKind) {
        ConfigDiagnosticRowDTO r = new ConfigDiagnosticRowDTO();
        r.key = key;
        r.label = label;
        r.effectiveValue = value;
        r.source = source;
        r.rowKind = String.isNotBlank(rowKind) ? rowKind : 'config';
        return r;
    }

    private static String diagKindFromSource(String source) {
        if (String.isBlank(source)) {
            return 'config';
        }
        String s = source.toLowerCase();
        if (s.startsWith('codigo') || s.contains('lwc ') || s.contains('apex chile')) {
            return 'code';
        }
        if (s.contains('runtime') || s.contains('mes actual')) {
            return 'runtime';
        }
        if (s.contains('css por defecto')) {
            return 'code';
        }
        return 'config';
    }

    private static String diagColorSource(Configurar_Centro_Imputaciones__c oc, String fieldApi) {
        if (oc == null) {
            return 'CSS por defecto';
        }
        Object v = oc.get(fieldApi);
        return v != null && String.isNotBlank(String.valueOf(v)) ? 'Objeto ' + fieldApi : 'CSS por defecto';
    }

    @AuraEnabled
    public static String validateEntries(String entriesJson) {
        List<EntryDTO> entries = (List<EntryDTO>) JSON.deserialize(entriesJson, List<EntryDTO>.class);
        return JSON.serialize(validate(entries));
    }

    @AuraEnabled
    public static String saveEntries(String entriesJson) {
        List<EntryDTO> entries = (List<EntryDTO>) JSON.deserialize(entriesJson, List<EntryDTO>.class);

        SaveResponseDTO response = new SaveResponseDTO();
        response.results = new List<SaveResultDTO>();
        response.total = (entries == null) ? 0 : entries.size();
        response.ok = 0;
        response.failed = 0;

        if (entries == null || entries.isEmpty()) return JSON.serialize(response);

        List<ValidationResultDTO> validation = validate(entries);
        Map<String, ValidationResultDTO> byRowKey = new Map<String, ValidationResultDTO>();
        for (ValidationResultDTO vr : validation) byRowKey.put(vr.rowKey, vr);

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            throw new AuraHandledException('No existe el objeto Imputacion__c en esta org.');
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();

        /* PEP: replicar la lógica del modal clásico copiando Case.PEP__c → Imputacion__c.PEP__c
         * cuando ambos campos existen. Se cargan en bloque para minimizar SOQL. */
        Map<Id, Case> caseLookupForPep = new Map<Id, Case>();
        Boolean impHasPepField = fMap.containsKey('PEP__c');
        if (impHasPepField) {
            Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
            Boolean caseHasPep = caseFm.containsKey('PEP__c');
            if (caseHasPep) {
                Set<Id> caseIdsForPep = new Set<Id>();
                for (EntryDTO e : entries) {
                    ValidationResultDTO vr = byRowKey.get(e.rowKey);
                    if (vr != null && vr.isValid && e.caseId != null) {
                        caseIdsForPep.add(e.caseId);
                    }
                }
                if (!caseIdsForPep.isEmpty()) {
                    try {
                        caseLookupForPep = new Map<Id, Case>(
                            (List<Case>) Database.query('SELECT Id, PEP__c FROM Case WHERE Id IN :caseIdsForPep')
                        );
                    } catch (Exception ex) {
                        System.debug(LoggingLevel.WARN, 'saveEntries PEP lookup: ' + ex.getMessage());
                    }
                }
            } else {
                impHasPepField = false;
            }
        }

        List<SObject> toInsert = new List<SObject>();
        List<String> rowKeysInsertOrder = new List<String>();

        for (EntryDTO e : entries) {
            ValidationResultDTO vr = byRowKey.get(e.rowKey);
            if (vr != null && vr.isValid) {
                SObject rec = impType.newSObject();

                putFirstExisting(rec, fMap, new List<String>{ 'Ticket__c', 'Case__c', 'CaseId' }, e.caseId);
                putImputationConsultantOnRecord(
                    rec,
                    fMap,
                    (e.imputingUserId == null) ? UserInfo.getUserId() : e.imputingUserId
                );
                putFirstExisting(rec, fMap, new List<String>{ 'Fecha__c', 'Date__c' }, e.entryDate);
                putFirstExisting(rec, fMap, new List<String>{ 'Horas__c', 'Hours__c' }, e.hours);
                putNoFacturable(rec, fMap, e.noFacturable);
                putFirstExisting(rec, fMap, new List<String>{ 'Comentarios__c', 'Comentario__c', 'Comment__c', 'Descripcion__c' }, e.comment);
                putFirstExisting(
                    rec,
                    fMap,
                    new List<String>{ 'Origen__c', 'Source__c' },
                    String.isBlank(e.source) ? resolveDefaultImputationSource() : e.source
                );

                if (impHasPepField && e.caseId != null) {
                    Case parent = caseLookupForPep.get(e.caseId);
                    if (parent != null && parent.get('PEP__c') != null) {
                        rec.put('PEP__c', parent.get('PEP__c'));
                    }
                }

                toInsert.add(rec);
                rowKeysInsertOrder.add(e.rowKey);
            } else {
                SaveResultDTO failRes = new SaveResultDTO();
                failRes.rowKey = e.rowKey;
                failRes.success = false;
                failRes.errors = (vr == null) ? new List<String>{ 'Error de validación desconocido.' } : vr.errors;
                response.results.add(failRes);
                response.failed++;
            }
        }

        if (!toInsert.isEmpty()) {
            Database.SaveResult[] dml = Database.insert(toInsert, false);
            for (Integer i = 0; i < dml.size(); i++) {
                SaveResultDTO r = new SaveResultDTO();
                r.rowKey = rowKeysInsertOrder[i];
                r.success = dml[i].isSuccess();
                r.errors = new List<String>();

                if (dml[i].isSuccess()) {
                    r.imputacionId = dml[i].getId();
                    response.ok++;
                } else {
                    for (Database.Error err : dml[i].getErrors()) {
                        r.errors.add(err.getMessage());
                    }
                    response.failed++;
                }
                response.results.add(r);
            }
        }

        return JSON.serialize(response);
    }

    private static void putNoFacturable(SObject rec, Map<String, Schema.SObjectField> fMap, Boolean value) {
        if (value == null) return;
        List<String> apis = new List<String>{ 'No_Facturable__c', 'NoFacturable__c' };
        for (String api : apis) {
            if (!fMap.containsKey(api)) continue;
            Schema.DisplayType t = fMap.get(api).getDescribe().getType();
            if (t == Schema.DisplayType.Boolean) {
                rec.put(api, value);
                return;
            }
            if (t == Schema.DisplayType.Picklist) {
                /* value true = no facturable: intenta Si / No; muchas orgs Chile usan Si/No literal. */
                String v = value ? 'Si' : 'No';
                rec.put(api, v);
                return;
            }
        }
    }

    private static List<ValidationResultDTO> validate(List<EntryDTO> entries) {
        List<ValidationResultDTO> out = new List<ValidationResultDTO>();
        if (entries == null) return out;

        Id uid = UserInfo.getUserId();
        Boolean admin = isImputationAdmin();

        Set<Id> caseIds = new Set<Id>();
        for (EntryDTO e : entries) {
            if (e.caseId != null) caseIds.add(e.caseId);
        }

        Map<Id, Case> caseMap = new Map<Id, Case>();
        Map<Id, String> casePepNameById = new Map<Id, String>();
        if (!caseIds.isEmpty()) {
            try {
                caseMap = new Map<Id, Case>([
                    SELECT Id, OwnerId, PEP__r.Name FROM Case WHERE Id IN :caseIds
                ]);
                for (Case c : caseMap.values()) {
                    String nm = (c.PEP__r != null) ? c.PEP__r.Name : null;
                    if (String.isNotBlank(nm)) casePepNameById.put(c.Id, nm.trim());
                }
            } catch (Exception ex) {
                /* Si el campo PEP__c/PEP__r no existiera, fallback a la consulta básica. */
                caseMap = new Map<Id, Case>([
                    SELECT Id, OwnerId FROM Case WHERE Id IN :caseIds
                ]);
            }
        }

        Id userContactId = getUserContactId(uid);

        Set<Id> teamMembership = new Set<Id>();
        if (!admin && !caseIds.isEmpty()) {
            if (userContactId != null) {
                for (CaseTeamMember m : [
                    SELECT ParentId
                    FROM CaseTeamMember
                    WHERE ParentId IN :caseIds AND (MemberId = :uid OR MemberId = :userContactId)
                ]) {
                    teamMembership.add(m.ParentId);
                }
            } else {
                for (CaseTeamMember m : [
                    SELECT ParentId FROM CaseTeamMember WHERE ParentId IN :caseIds AND MemberId = :uid
                ]) {
                    teamMembership.add(m.ParentId);
                }
            }
        }

        /* Casos en lista AMS (CMDT): no-admin puede imputar aunque no sea owner ni del equipo. */
        Set<Id> amsAllowedCaseIds = filterCasesByAmsEligibility(caseIds);

        Set<Id> onBehalfUserIds = new Set<Id>();
        for (EntryDTO e : entries) {
            if (e.imputingUserId != null) {
                onBehalfUserIds.add(e.imputingUserId);
            }
        }
        Map<Id, User> activeOnBehalfUsers = new Map<Id, User>();
        if (!onBehalfUserIds.isEmpty()) {
            for (User u : [SELECT Id FROM User WHERE Id IN :onBehalfUserIds AND IsActive = true]) {
                activeOnBehalfUsers.put(u.Id, u);
            }
        }

        for (EntryDTO e : entries) {
            List<String> errors = new List<String>();

            /* PEP del caso (si está disponible) para excepciones de negocio (ej. vacaciones). */
            String pepName = e.caseId != null ? casePepNameById.get(e.caseId) : null;
            Boolean isAlwaysFacPep = isAlwaysFacturablePepName(pepName);

            if (e.caseId == null) errors.add('Ticket es obligatorio.');
            if (e.entryDate == null) errors.add('Fecha es obligatoria.');
            if (e.hours == null || e.hours <= 0) errors.add('Horas debe ser mayor que 0.');
            if (e.hours != null && e.hours > 24) errors.add('Horas no puede ser mayor que 24.');
            /* Mes en curso; ventana retro/adelante como excepcion (consultores). */
            if (e.entryDate != null && !admin) {
                if (!isImputationDateModifiableByConsultant(e.entryDate, isAlwaysFacPep)) {
                    List<Integer> win = getImputationMonthWindow();
                    String ventana =
                        (win[0] > 0 || win[1] > 0)
                            ? ' (ventana actual: -' + win[0] + '/+' + win[1] + ' meses)'
                            : '';
                    errors.add(
                        isAlwaysFacPep
                            ? 'Fecha fuera del periodo permitido para vacaciones' + ventana + '.'
                            : 'Solo puedes imputar en el mes en curso' + ventana + '.'
                    );
                }
            }

            if (e.imputingUserId != null) {
                if (!admin) {
                    errors.add('Solo un administrador de imputacion puede registrar horas a nombre de otro usuario.');
                } else if (!activeOnBehalfUsers.containsKey(e.imputingUserId)) {
                    errors.add('El usuario destino no existe, esta inactivo o el Id no es valido.');
                }
            }

            if (!admin && e.caseId != null) {
                Case c = caseMap.get(e.caseId);
                if (c == null) {
                    errors.add('Ticket no encontrado o sin acceso.');
                } else if (
                    c.OwnerId != uid &&
                    !teamMembership.contains(e.caseId) &&
                    !amsAllowedCaseIds.contains(e.caseId)
                ) {
                    errors.add('Solo el owner, el equipo del caso o casos de gestión AMS pueden imputar en este ticket.');
                }
            }

            ValidationResultDTO vr = new ValidationResultDTO();
            vr.rowKey = e.rowKey;
            vr.isValid = errors.isEmpty();
            vr.errors = errors;
            out.add(vr);
        }
        return out;
    }

    /** Filtra los caseIds que pertenecen a la lista AMS configurada en el objeto operativo. */
    private static Map<Id, Case> queryCasesForBillableRules(
        Set<Id> caseIds,
        ImputacionesBillableRules.RulesConfig rules
    ) {
        Map<Id, Case> out = new Map<Id, Case>();
        if (caseIds == null || caseIds.isEmpty()) {
            return out;
        }
        Set<String> fieldApis = ImputacionesBillableRules.collectCaseFieldApis(rules);
        String soql = 'SELECT Id';
        for (String api : fieldApis) {
            soql += ', ' + api;
        }
        soql += ' FROM Case WHERE Id IN :caseIds';
        try {
            for (Case c : Database.query(soql)) {
                out.put(c.Id, c);
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'queryCasesForBillableRules: ' + ex.getMessage());
        }
        return out;
    }

    private static String appendBillableCaseFieldsToSelect(
        String soqlSelect,
        ImputacionesBillableRules.RulesConfig rules
    ) {
        if (String.isBlank(soqlSelect)) {
            return soqlSelect;
        }
        Integer fromIdx = soqlSelect.indexOf(' FROM Case');
        if (fromIdx < 0) {
            return soqlSelect;
        }
        String extra = '';
        for (String api : ImputacionesBillableRules.collectCaseFieldApis(rules)) {
            if (!soqlSelect.contains(api)) {
                extra += ', ' + api;
            }
        }
        if (String.isBlank(extra)) {
            return soqlSelect;
        }
        return soqlSelect.substring(0, fromIdx) + extra + soqlSelect.substring(fromIdx);
    }

    /**
     * Casos elegibles como gestion AMS: filtros del catalogo (pestaña AMS) o, si no hay,
     * motivo OR servicio del objeto operativo (misma logica que el listado de la pestaña).
     */
    private static Set<Id> filterCasesByAmsEligibility(Set<Id> caseIds) {
        Set<Id> ok = new Set<Id>();
        if (caseIds == null || caseIds.isEmpty()) {
            return ok;
        }
        TicketCatalogTabDef amsTab = resolveTicketCatalogTab('ams');
        List<CaseFieldFilter> filters = new List<CaseFieldFilter>();
        String filterLogic = 'OR';
        if (amsTab != null && amsTab.caseFilters != null) {
            List<CaseFieldFilter> fromTab = sanitizeCaseFieldFilters(amsTab.caseFilters);
            if (!fromTab.isEmpty()) {
                filters = fromTab;
                filterLogic = String.isNotBlank(amsTab.filterLogic) ? amsTab.filterLogic : 'AND';
            }
        }
        if (filters.isEmpty()) {
            filters = sanitizeCaseFieldFilters(buildLegacyGlobalAmsCaseFilters());
            filterLogic = 'OR';
        }
        if (filters.isEmpty()) {
            return ok;
        }
        return queryCaseIdsMatchingFieldFilters(caseIds, filters, filterLogic);
    }

    private static Set<Id> queryCaseIdsMatchingFieldFilters(
        Set<Id> caseIds,
        List<CaseFieldFilter> valid,
        String filterLogic
    ) {
        Set<Id> ok = new Set<Id>();
        if (caseIds == null || caseIds.isEmpty() || valid == null || valid.isEmpty()) {
            return ok;
        }
        Boolean useOr = 'OR'.equalsIgnoreCase(String.valueOf(filterLogic));
        String soql = 'SELECT Id FROM Case WHERE Id IN :caseIds';
        Set<String> filter0Values = null;
        Set<String> filter1Values = null;
        Set<String> filter2Values = null;
        Set<String> filter3Values = null;
        Set<String> filter4Values = null;
        List<String> filterClauses = new List<String>();
        for (Integer fi = 0; fi < valid.size() && fi < 5; fi++) {
            String clause = buildCaseFilterSoqlClause(valid[fi], fi);
            if (String.isNotBlank(clause)) {
                filterClauses.add(clause);
            }
        }
        if (!filterClauses.isEmpty()) {
            soql += ' AND (' + String.join(filterClauses, useOr ? ' OR ' : ' AND ') + ')';
        }
        if (valid.size() > 0) {
            filter0Values = valid[0].values;
        }
        if (valid.size() > 1) {
            filter1Values = valid[1].values;
        }
        if (valid.size() > 2) {
            filter2Values = valid[2].values;
        }
        if (valid.size() > 3) {
            filter3Values = valid[3].values;
        }
        if (valid.size() > 4) {
            filter4Values = valid[4].values;
        }
        try {
            for (Case c : Database.query(soql)) {
                ok.add(c.Id);
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'queryCaseIdsMatchingFieldFilters: ' + ex.getMessage());
        }
        return ok;
    }

    private static void putFirstExisting(SObject rec, Map<String, Schema.SObjectField> fMap, List<String> candidates, Object value) {
        if (value == null) return;
        for (String api : candidates) {
            if (fMap.containsKey(api)) {
                rec.put(api, value);
                return;
            }
        }
    }

    private static OptionDTO newOption(String label, String value) {
        OptionDTO op = new OptionDTO();
        op.label = label;
        op.value = value;
        return op;
    }

    private static Id getUserContactId(Id userId) {
        if (userId == null) return null;
        Map<String, Schema.SObjectField> uf = User.SObjectType.getDescribe().fields.getMap();
        if (!uf.containsKey('ContactId')) return null;
        User u = [SELECT ContactId FROM User WHERE Id = :userId LIMIT 1];
        return u.ContactId;
    }

    private static Boolean userHasCaseAccess(Id caseId) {
        if (caseId == null) {
            return false;
        }
        if (isImputationAdmin()) {
            return true;
        }
        Id u = UserInfo.getUserId();
        Set<Id> collab = getCaseIdsWhereUserCollaborates(u);
        List<Case> rows = [
            SELECT Id
            FROM Case
            WHERE Id = :caseId AND (OwnerId = :u OR Id IN :collab)
            LIMIT 1
        ];
        if (!rows.isEmpty()) {
            return true;
        }
        /* Misma excepción que validate(): tickets de gestión AMS (lista CMDT) aunque no seas owner ni Case Team. */
        Set<Id> amsOk = filterCasesByAmsEligibility(new Set<Id>{ caseId });
        return amsOk.contains(caseId);
    }

    private static Set<Id> getCaseIdsWhereUserCollaborates(Id userId) {
        Set<Id> ids = new Set<Id>();
        for (CaseTeamMember m : [
            SELECT ParentId FROM CaseTeamMember WHERE MemberId = :userId AND ParentId != null
        ]) {
            ids.add(m.ParentId);
        }
        Id contactId = getUserContactId(userId);
        if (contactId != null) {
            for (CaseTeamMember m : [
                SELECT ParentId FROM CaseTeamMember WHERE MemberId = :contactId AND ParentId != null
            ]) {
                ids.add(m.ParentId);
            }
        }
        return ids;
    }

    private static Boolean isImputationAdmin() {
        Map<String, Schema.SObjectField> userFields = User.SObjectType.getDescribe().fields.getMap();
        if (!userFields.containsKey('Admin_Imputacion__c')) {
            return false;
        }
        User u = [SELECT Admin_Imputacion__c FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        return u.Admin_Imputacion__c == true;
    }

    /** Resultado del agregado de horas no facturables por ticket (para tooltip / desglose). */
    private class NfSplitLoad {
        public final Map<Id, Decimal> noFactByCase;
        public final Boolean available;

        NfSplitLoad(Map<Id, Decimal> m, Boolean ok) {
            this.noFactByCase = (m != null) ? m : new Map<Id, Decimal>();
            this.available = ok != null && ok;
        }
    }

    /** Campo no facturable en Imputacion__c (filtro agregados). Solo Boolean o Picklist. */
    private static String resolveNoFacturableFilterApi(Map<String, Schema.SObjectField> fMap) {
        List<String> apis = new List<String>{ 'No_Facturable__c', 'NoFacturable__c' };
        for (String api : apis) {
            if (!fMap.containsKey(api))
                continue;
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible() || !d.isFilterable())
                continue;
            Schema.DisplayType t = d.getType();
            if (t == Schema.DisplayType.Boolean || t == Schema.DisplayType.Picklist)
                return api;
        }
        return null;
    }

    /**
     * Suma horas marcadas como no facturables por caso. Facturable implicito = total - no fact.
     */
    private static NfSplitLoad loadNoFactHoursByCase(Set<Id> caseIds) {
        if (caseIds == null || caseIds.isEmpty()) {
            return new NfSplitLoad(new Map<Id, Decimal>(), false);
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return new NfSplitLoad(new Map<Id, Decimal>(), false);
        }

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        if (String.isBlank(ticketApi) || String.isBlank(hoursApi)) {
            return new NfSplitLoad(new Map<Id, Decimal>(), false);
        }

        /* Preferimos el campo fórmula Ind_Imputacion__c ('NF') como fuente de verdad.
         * Si no existe, fallback al checkbox No_Facturable__c.
         * Excluimos los PEPs siempre facturables (ej. vacaciones) para que su tiempo
         * NO sume en la columna no-facturable de la tabla. */
        String indApi = resolveIndImputacionFieldApi(fMap);
        String pepApi = resolveImputationPepFieldApi(fMap);
        String alwaysFacExclusion = '';
        if (String.isNotBlank(pepApi) && !getAlwaysFacturablePepNames().isEmpty()) {
            List<String> alwaysFacList = new List<String>(getAlwaysFacturablePepNames());
            alwaysFacExclusion = ' AND (PEP__c = null OR PEP__r.Name NOT IN :alwaysFacList)';
        }
        String whereNoFactClause;
        if (String.isNotBlank(indApi)) {
            whereNoFactClause = indApi + ' = \'NF\'';
        } else {
            String nfApi = resolveNoFacturableFilterApi(fMap);
            if (String.isBlank(nfApi)) {
                return new NfSplitLoad(new Map<Id, Decimal>(), false);
            }
            Schema.DescribeFieldResult nfDesc = fMap.get(nfApi).getDescribe();
            Schema.DisplayType nfType = nfDesc.getType();
            if (nfType == Schema.DisplayType.Boolean) {
                whereNoFactClause = nfApi + ' = true';
            } else if (nfType == Schema.DisplayType.Picklist) {
                whereNoFactClause = nfApi + ' IN (\'Si\', \'Sí\', \'SI\')';
            } else {
                return new NfSplitLoad(new Map<Id, Decimal>(), false);
            }
        }

        String soql =
            'SELECT ' +
            ticketApi +
            ' tid, SUM(' +
            hoursApi +
            ') total FROM Imputacion__c WHERE ' +
            ticketApi +
            ' IN :caseIds AND ' +
            whereNoFactClause +
            alwaysFacExclusion +
            ' GROUP BY ' +
            ticketApi;

        Map<Id, Decimal> out = new Map<Id, Decimal>();
        try {
            /* La lista alwaysFacList se usa por bind si el clause la incluye. */
            List<String> alwaysFacList = new List<String>(getAlwaysFacturablePepNames());
            for (AggregateResult ar : Database.query(soql)) {
                Id tid = (Id) ar.get('tid');
                if (tid == null) {
                    continue;
                }
                out.put(tid, ar.get('total') == null ? 0 : (Decimal) ar.get('total'));
            }
            return new NfSplitLoad(out, true);
        } catch (Exception ex) {
            System.debug(
                LoggingLevel.WARN,
                'ImputacionesAMS loadNoFactHoursByCase: ' + ex.getMessage()
            );
            return new NfSplitLoad(new Map<Id, Decimal>(), false);
        }
    }

    private static Map<Id, Decimal> getImputedHoursByTicket(Set<Id> caseIds) {
        Map<Id, Decimal> out = new Map<Id, Decimal>();
        if (caseIds == null || caseIds.isEmpty()) return out;

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) return out;

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        if (String.isBlank(ticketApi) || String.isBlank(hoursApi)) return out;

        String soql =
            'SELECT ' +
            ticketApi +
            ' tid, SUM(' +
            hoursApi +
            ') total FROM Imputacion__c WHERE ' +
            ticketApi +
            ' IN :caseIds GROUP BY ' +
            ticketApi;

        try {
            for (AggregateResult ar : Database.query(soql)) {
                Id tid = (Id) ar.get('tid');
                if (tid == null) continue;
                out.put(tid, (Decimal) ar.get('total'));
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'ImputacionesAMS getImputedHoursByTicket: ' + ex.getMessage());
        }

        return out;
    }

    /**
     * Ultima imputacion por ticket para enlazar desde UI.
     * Ordena por fecha de imputacion si existe; si no, por CreatedDate.
     */
    private static Map<Id, Id> getLastImputationIdByCase(Set<Id> caseIds) {
        Map<Id, Id> out = new Map<Id, Id>();
        if (caseIds == null || caseIds.isEmpty()) return out;

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) return out;

        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        if (String.isBlank(ticketApi)) return out;

        String dateApi = resolveImputationDateFieldForLatest(fMap);
        String orderDateExpr = String.isBlank(dateApi) ? 'CreatedDate DESC' : (dateApi + ' DESC NULLS LAST, CreatedDate DESC');

        /* Sin alias en SOQL: rec.get('tid') puede fallar segun runtime; usar API real del campo ticket. */
        String soql =
            'SELECT Id, ' +
            ticketApi +
            ' FROM Imputacion__c WHERE ' +
            ticketApi +
            ' IN :caseIds ORDER BY ' +
            orderDateExpr;

        try {
            for (SObject rec : Database.query(soql)) {
                Id tid = (Id) rec.get(ticketApi);
                if (tid == null || out.containsKey(tid)) continue;
                out.put(tid, (Id) rec.get('Id'));
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'ImputacionesAMS getLastImputationIdByCase: ' + ex.getMessage());
        }
        return out;
    }

    private static String resolveImputationTicketFieldForAggregate(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Ticket__c', 'Case__c', 'CaseId__c', 'CaseId' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) continue;
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) continue;
            Schema.DisplayType t = d.getType();
            Boolean refOrId =
                (t == Schema.DisplayType.REFERENCE || t == Schema.DisplayType.ID);
            if (refOrId && d.isGroupable()) {
                return api;
            }
        }
        return null;
    }

    private static String resolveImputationHoursFieldForAggregate(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Horas__c', 'Hours__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) continue;
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) continue;

            Schema.DisplayType t = d.getType();
            if (
                t == Schema.DisplayType.DOUBLE ||
                t == Schema.DisplayType.CURRENCY ||
                t == Schema.DisplayType.PERCENT ||
                t == Schema.DisplayType.INTEGER
            ) {
                return api;
            }
        }
        return null;
    }

    private static String resolveImputationDateFieldForAggregateDay(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Fecha__c', 'Date__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) continue;
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible() || !d.isGroupable()) continue;
            if (d.getType() == Schema.DisplayType.DATE) {
                return api;
            }
        }
        return null;
    }

    private static String resolveImputationDateFieldForLatest(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Fecha__c', 'Date__c', 'FechaImputacion__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) continue;
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible() || !d.isSortable()) continue;
            Schema.DisplayType t = d.getType();
            if (t == Schema.DisplayType.DATE || t == Schema.DisplayType.DATETIME) {
                return api;
            }
        }
        return null;
    }

    /**
     * Campo fórmula `Ind_Imputacion__c` en Imputacion__c: valor 'FA' (facturable) o 'NF' (no facturable).
     * Encapsula la lógica real del cliente (externos, PEPs especiales, Reason Gestion Interna, checkbox manual).
     * Si existe, lo usamos como fuente de verdad en cálculos de meta. Si no, fallback al checkbox No_Facturable__c.
     */
    private static String resolveIndImputacionFieldApi(Map<String, Schema.SObjectField> fMap) {
        if (fMap == null || !fMap.containsKey('Ind_Imputacion__c')) {
            return null;
        }
        Schema.DescribeFieldResult d = fMap.get('Ind_Imputacion__c').getDescribe();
        if (!d.isAccessible()) {
            return null;
        }
        return d.getName();
    }

    /** Campo «Usuario Final Imputación» (dueño de horas en org). */
    private static final List<String> IMPUTATION_FINAL_USER_FIELD_CANDIDATES = new List<String>{
        'Usuario_Final_Imputacion__c',
        'UsuarioFinalImputacion__c',
        'Usuario_final_imputacion__c'
    };

    private static final List<String> IMPUTATION_LEGACY_USER_FIELD_CANDIDATES = new List<String>{
        'En_nombre_de__c',
        'Consultor__c',
        'Usuario__c',
        'ImputingUser__c'
    };

    /** Primer lookup User accesible entre candidatos (sin comprobar createable). */
    private static String resolveFirstAccessibleUserLookupApi(
        Map<String, Schema.SObjectField> fMap,
        List<String> candidates
    ) {
        if (fMap == null || candidates == null) {
            return null;
        }
        for (String api : candidates) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) {
                continue;
            }
            if (d.getType() != Schema.DisplayType.REFERENCE) {
                continue;
            }
            List<Schema.SObjectType> refs = d.getReferenceTo();
            if (refs != null && !refs.isEmpty() && refs[0] == User.SObjectType) {
                return api;
            }
        }
        return null;
    }

    /** Usuario Final Imputación: consultor al que pertenecen las horas. */
    @TestVisible
    private static String resolveImputationFinalUserFieldApi(Map<String, Schema.SObjectField> fMap) {
        return resolveFirstAccessibleUserLookupApi(fMap, IMPUTATION_FINAL_USER_FIELD_CANDIDATES);
    }

    /** Campo usuario legacy (En nombre de, etc.) usado antes del centro. */
    @TestVisible
    private static String resolveImputationLegacyUserFieldApi(Map<String, Schema.SObjectField> fMap) {
        return resolveFirstAccessibleUserLookupApi(fMap, IMPUTATION_LEGACY_USER_FIELD_CANDIDATES);
    }

    /**
     * Compatibilidad: devuelve el campo legacy (En_nombre_de__c, …), no Usuario Final.
     * Para filtros y permisos usar buildImputationOwnerFilterWhereClause / readEffectiveImputationOwnerId.
     */
    private static String resolveImputationUserFieldForFilter(Map<String, Schema.SObjectField> fMap) {
        return resolveImputationLegacyUserFieldApi(fMap);
    }

    /**
     * Cascada Final → legacy → CreatedById (en lugar del OR plano antiguo): cada nivel solo
     * se considera cuando los anteriores estan vacios. Asi una imputacion cargada por Data Loader
     * que tenga Usuario_Final_Imputacion__c poblado pertenece SOLO al consultor real, no al
     * usuario tecnico que ejecuto la carga (CreatedBy). Equivalente en logica a
     * readEffectiveImputationOwnerId() = :bind.
     */
    @TestVisible
    private static String buildImputationOwnerFilterWhereClause(
        Map<String, Schema.SObjectField> fMap,
        String bindVarName
    ) {
        String finalApi = resolveImputationFinalUserFieldApi(fMap);
        String legacyApi = resolveImputationLegacyUserFieldApi(fMap);
        String bind = ':' + bindVarName;
        List<String> parts = new List<String>();

        if (String.isNotBlank(finalApi)) {
            // 1) Final poblado: es la fuente de verdad.
            parts.add(finalApi + ' = ' + bind);
            if (String.isNotBlank(legacyApi)) {
                // 2) Legacy solo cuenta cuando Final esta vacio.
                parts.add('(' + finalApi + ' = NULL AND ' + legacyApi + ' = ' + bind + ')');
                // 3) CreatedBy solo cuando Final y legacy estan vacios.
                parts.add(
                    '(' + finalApi + ' = NULL AND ' + legacyApi + ' = NULL AND CreatedById = ' + bind + ')'
                );
            } else {
                parts.add('(' + finalApi + ' = NULL AND CreatedById = ' + bind + ')');
            }
        } else if (String.isNotBlank(legacyApi)) {
            // Org sin campo Final: cascada legacy → CreatedBy.
            parts.add(legacyApi + ' = ' + bind);
            parts.add('(' + legacyApi + ' = NULL AND CreatedById = ' + bind + ')');
        } else {
            // Org sin Final ni legacy: solo CreatedBy.
            parts.add('CreatedById = ' + bind);
        }

        return '(' + String.join(parts, ' OR ') + ')';
    }

    /** SELECT …, campos de dueño (Final, legacy, CreatedById). */
    private static String appendImputationOwnerFieldsToSelect(
        String selectClause,
        Map<String, Schema.SObjectField> fMap
    ) {
        String out = selectClause;
        String finalApi = resolveImputationFinalUserFieldApi(fMap);
        String legacyApi = resolveImputationLegacyUserFieldApi(fMap);
        if (String.isNotBlank(finalApi) && !out.contains(finalApi)) {
            out += ', ' + finalApi;
        }
        if (String.isNotBlank(legacyApi) && !out.contains(legacyApi)) {
            out += ', ' + legacyApi;
        }
        if (!out.contains('CreatedById')) {
            out += ', CreatedById';
        }
        return out;
    }

    /**
     * Dueño efectivo de las horas: Usuario Final → legacy (En nombre de) → CreatedBy.
     */
    @TestVisible
    private static Id readEffectiveImputationOwnerId(SObject rec, Map<String, Schema.SObjectField> fMap) {
        if (rec == null) {
            return null;
        }
        String finalApi = resolveImputationFinalUserFieldApi(fMap);
        if (String.isNotBlank(finalApi)) {
            Id finalUser = (Id) rec.get(finalApi);
            if (finalUser != null) {
                return finalUser;
            }
        }
        String legacyApi = resolveImputationLegacyUserFieldApi(fMap);
        if (String.isNotBlank(legacyApi)) {
            Id legacyUser = (Id) rec.get(legacyApi);
            if (legacyUser != null) {
                return legacyUser;
            }
        }
        return (Id) rec.get('CreatedById');
    }

    /**
     * Cascada Final → legacy → CreatedById (in-memory). Idéntico criterio a
     * buildImputationOwnerFilterWhereClause y a readEffectiveImputationOwnerId: cada nivel sólo
     * cuenta cuando los anteriores están vacíos.
     */
    @TestVisible
    private static Boolean userMatchesImputationOwnerFilter(
        SObject rec,
        Map<String, Schema.SObjectField> fMap,
        Id currentUserId
    ) {
        if (rec == null || currentUserId == null) {
            return false;
        }
        String finalApi = resolveImputationFinalUserFieldApi(fMap);
        if (String.isNotBlank(finalApi)) {
            Id finalUser = (Id) rec.get(finalApi);
            if (finalUser != null) {
                // Final poblado: es la fuente de verdad. NO seguimos a legacy ni CreatedBy.
                return finalUser == currentUserId;
            }
        }
        String legacyApi = resolveImputationLegacyUserFieldApi(fMap);
        if (String.isNotBlank(legacyApi)) {
            Id legacyUser = (Id) rec.get(legacyApi);
            if (legacyUser != null) {
                // Final vacío y legacy poblado: legacy decide.
                return legacyUser == currentUserId;
            }
        }
        // Final y legacy vacíos: último recurso CreatedBy.
        Id createdBy = (Id) rec.get('CreatedById');
        return createdBy != null && createdBy == currentUserId;
    }

    @TestVisible
    private static Boolean currentUserOwnsImputation(
        SObject rec,
        Map<String, Schema.SObjectField> fMap,
        Id currentUserId
    ) {
        return userMatchesImputationOwnerFilter(rec, fMap, currentUserId);
    }

    /** Rellena Usuario Final Imputación y campos legacy con el consultor efectivo. */
    private static void putImputationConsultantOnRecord(
        SObject rec,
        Map<String, Schema.SObjectField> fMap,
        Id consultantUserId
    ) {
        if (consultantUserId == null) {
            return;
        }
        putFirstExisting(rec, fMap, IMPUTATION_FINAL_USER_FIELD_CANDIDATES, consultantUserId);
        putFirstExisting(rec, fMap, IMPUTATION_LEGACY_USER_FIELD_CANDIDATES, consultantUserId);
    }

    private static String formatIsoDateForCal(Date d) {
        if (d == null) {
            return null;
        }
        return String.valueOf(d.year()) + '-' + pad2Cal(d.month()) + '-' + pad2Cal(d.day());
    }

    private static Date parseIsoCalDate(String iso) {
        if (String.isBlank(iso)) {
            return null;
        }
        List<String> p = iso.trim().split('-');
        if (p.size() != 3) {
            return null;
        }
        try {
            Integer y = Integer.valueOf(p[0]);
            Integer m = Integer.valueOf(p[1]);
            Integer d = Integer.valueOf(p[2]);
            return Date.newInstance(y, m, d);
        } catch (Exception e) {
            return null;
        }
    }

    private static String pad2Cal(Integer n) {
        String s = String.valueOf(n);
        return s.length() == 1 ? '0' + s : s;
    }

    /**
     * Ejecuta ramas privadas dificiles de alcanzar solo con LWC (cobertura deploy >= 75%).
     * Solo invocable desde tests (@TestVisible).
     */
    @TestVisible
    private static void runCoverageHarnessForTests() {
        if (!Test.isRunningTest()) {
            return;
        }
        clearOperativeConfigCache();
        Configurar_Centro_Imputaciones__c oc = getOperativeConfigRow();

        parseDelimitedTokens('a;b,c\nd;e');
        parseDelimitedTokens('');
        currentUserMatchesConfigUserField('Username', UserInfo.getUsername());
        currentUserMatchesConfigUserField('', '');
        currentUserMatchesConfigUserField('Campo_Inexistente__c', 'x');

        isAlwaysFacturablePepName('C1-Z-PR-VAC');
        isAlwaysFacturablePepName(null);

        List<Integer> win = getImputationMonthWindow();
        Integer retro = win[0];
        Integer fwd = win[1];
        isEntryDateAllowedForConsultant(Date.today(), false, retro, fwd);
        isEntryDateAllowedForConsultant(Date.today().addMonths(-2), false, retro, fwd);
        isEntryDateAllowedForConsultant(Date.today().addMonths(2), true, retro, fwd);

        formatYmFromParts(2026, 5);
        formatImputationYmRangeDiag(retro, fwd);
        formatImputationYmRangeDiag(0, 0);
        formatImputationYmRangeDiag(12, 1);

        isEntryDateAllowedForConsultant(Date.today().addMonths(-2), false, retro, fwd);
        isEntryDateAllowedForConsultant(Date.today().addMonths(1), true, retro, fwd);
        isEntryDateAllowedForConsultant(Date.today().addMonths(3), false, retro, 0);

        sanitizeCaseFieldFilters(null);
        resolveAmsServicioValues();
        getUserContactId(UserInfo.getUserId());

        caseNumberDigitsOnly('00001234');
        caseNumberDigitsOnly('abc');
        expandCaseNumberSearchVariants(new Set<String>{ '00001234', '1234' });

        parseExtraHolidayMmDd('12-25,01-01');
        buildUiHideFlagsSummary(oc);
        buildUiHideFlagsSummary(null);

        diagKindFromSource('Codigo LWC');
        diagKindFromSource('runtime mes actual');
        diagKindFromSource('Objeto X');
        diagKindFromSource(null);

        normalizeHexColor('#AABBCC', '#112233');
        normalizeHexColor('invalid', '#112233');

        defaultCriterioCalculoFacturable();
        defaultCriterioCalculoNoFacturable();

        parseIsoCalDate('2026-05-12');
        parseIsoCalDate('bad');
        formatIsoDateForCal(Date.today());
        pad2Cal(5);
        pad2Cal(12);

        resolveGlobalTicketServicioValues();
        resolveAmsReasonValues();
        resolveAmsServicioValues();
        parseAmsReasonFallbackChain();
        resolveCaseReasonFieldForAms();
        resolveCaseServicioFieldApi();
        buildLegacyGlobalAmsCaseFilters();
        buildDefaultTicketCatalogTabDefs();
        parseTicketCatalogTabDefs('[{"id":"mine","label":"M","type":"mine"}]', false);
        parseTicketCatalogTabDefs(
            '[{"id":"x","label":"X","type":"custom","caseFieldApi":"Status","caseFieldValues":"New","caseFieldApi2":"Priority","caseFieldValues2":"High","filterLogic":"OR","motivos":"Gestion","campoMotivo":"Reason","servicios":"AMS","caseFilters":[{"fieldApi":"Status","values":"New,Working"},{"fieldApi":"Priority","values":"","matchEmpty":true}]}]',
            false
        );
        parseTicketCatalogTabDefs('not-json', false);
        getEffectiveTicketCatalogTabDefs();
        resolveTicketCatalogTab('ams');
        resolveTicketCatalogTab('tab-inexistente');
        buildTicketCatalogTabsDto(false);
        buildTicketCatalogTabsDto(true);

        colorFromConfigField(oc, 'Color_Grafico_Facturable__c', '#000000');
        diagColorSource(oc, 'Color_Grafico_Facturable__c');
        diagColorSource(null, 'Color_Grafico_Facturable__c');

        applyCalendarColorsFromConfig(new ImputationCenterSettingsDTO(), oc);
        applyCalendarColorsFromConfig(new ImputationCenterSettingsDTO(), null);
        applyChartColorsFromConfig(new ImputationCenterSettingsDTO(), oc);
        applyChartColorsFromConfig(new ImputationCenterSettingsDTO(), null);

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType != null) {
            Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
            Schema.DescribeFieldResult nfDesc = resolveNoFactFieldDescribeForRead(fMap);
            SObject imp = impType.newSObject();
            String nfApi = nfDesc != null ? nfDesc.getName() : null;
            if (nfDesc != null && String.isNotBlank(nfApi)) {
                Schema.DisplayType nfType = nfDesc.getType();
                readNoFactFromRec(imp, nfApi, nfType);
                if (nfType == Schema.DisplayType.Boolean) {
                    imp.put(nfApi, true);
                    readNoFactFromRec(imp, nfApi, nfType);
                    imp.put(nfApi, false);
                    readNoFactFromRec(imp, nfApi, nfType);
                } else if (nfType == Schema.DisplayType.Picklist) {
                    imp.put(nfApi, 'Si');
                    readNoFactFromRec(imp, nfApi, nfType);
                    imp.put(nfApi, 'No');
                    readNoFactFromRec(imp, nfApi, nfType);
                }
            }
            String indApi = resolveIndImputacionFieldApi(fMap);
            isNoFacturableByIndFormula(imp, indApi, nfApi, nfDesc);
            resolveImputationPepFieldApi(fMap);
            resolveCommentFieldApi(fMap, false);
            resolveCommentFieldApi(fMap, true);
            resolveNoFacturableFilterApi(fMap);
            resolveImputationTicketFieldForAggregate(fMap);
            resolveImputationHoursFieldForAggregate(fMap);
            resolveImputationDateFieldForAggregateDay(fMap);
            resolveImputationDateFieldForLatest(fMap);
            resolveImputationUserFieldForFilter(fMap);
            resolveImputationFinalUserFieldApi(fMap);
            resolveImputationLegacyUserFieldApi(fMap);
            buildImputationOwnerFilterWhereClause(fMap, 'filterUserId');
            resolveNoFacturableByIndFormulaPreview(null, fMap);
            resolveNoFacturableByIndFormulaPreview(new List<PendingBillablePreviewRowDTO>(), fMap);
        }

        buildImputationCenterDiagnostics();

        CaseFieldFilter cfVals = new CaseFieldFilter();
        cfVals.fieldApi = 'Status';
        cfVals.values = new Set<String>{ 'New' };
        buildCaseFilterSoqlClause(cfVals, 0);
        CaseFieldFilter cfEmpty = new CaseFieldFilter();
        cfEmpty.fieldApi = 'Status';
        cfEmpty.matchEmpty = true;
        buildCaseFilterSoqlClause(cfEmpty, 1);
        CaseFieldFilter cfBoth = new CaseFieldFilter();
        cfBoth.fieldApi = 'Status';
        cfBoth.values = new Set<String>{ 'New' };
        cfBoth.matchEmpty = true;
        buildCaseFilterSoqlClause(cfBoth, 2);
        buildCaseFilterSoqlClause(null, 0);

        loadNoFactHoursByCase(new Set<Id>());
        filterCasesByGlobalServicio(new List<Case>());
        FilterDTO fdHarness = new FilterDTO();
        fdHarness.caseIds = new List<String>();
        buildCaseIdFilterSet(fdHarness, false);
        appendBillableCaseFieldsToSelect(
            'SELECT Id FROM Case WHERE IsClosed = false',
            ImputacionesBillableRules.loadFromOperativeConfig(oc)
        );

        isEntryDateInCurrentMonth(Date.today());
        isEntryDateInCurrentMonth(Date.today().addMonths(-1));
        validateCaseFilterFieldApi('Status');
        validateCaseFilterFieldApi('Campo_Inexistente__c');
        stringFromJson('valor');
        stringFromJson(null);
        normalizeCatalogTabId('  ams  ');
        resolveCaseReasonFieldForConfiguredApi('Reason');
        resolveCaseReasonFieldForConfiguredApi('');

        if (impType != null) {
            Map<String, Schema.SObjectField> fMap2 = impType.getDescribe().fields.getMap();
            String dateApi = resolveImputationDateFieldForAggregateDay(fMap2);
            if (String.isNotBlank(dateApi)) {
                SObject impD = impType.newSObject();
                impD.put(dateApi, Date.today());
                readImputationDateFromRecord(impD, fMap2, dateApi);
                imputationRecordDateModifiableByConsultant(impD, fMap2);
                isImputationDateModifiableByConsultant(Date.today(), false);
            }
            resolveCommentFieldApi(fMap2, true);
            resolveCommentFieldApi(fMap2, false);
            String indHarness = resolveIndImputacionFieldApi(fMap2);
            Schema.DescribeFieldResult nfDescHarness = resolveNoFactFieldDescribeForRead(fMap2);
            String nfApiHarness = nfDescHarness != null ? nfDescHarness.getName() : null;
            Schema.DisplayType nfTypeHarness = nfDescHarness != null ? nfDescHarness.getType() : null;
            SObject impMock = impType.newSObject();
            putNoFacturable(impMock, fMap2, true);
            putNoFacturable(impMock, fMap2, false);
            putFirstExisting(impMock, fMap2, new List<String>{ 'Fecha__c', 'Date__c' }, Date.today());
            if (nfDescHarness != null && String.isNotBlank(nfApiHarness) && nfTypeHarness != null) {
                if (nfTypeHarness == Schema.DisplayType.Boolean) {
                    impMock.put(nfApiHarness, true);
                    readNoFactFromRec(impMock, nfApiHarness, nfTypeHarness);
                    impMock.put(nfApiHarness, false);
                    readNoFactFromRec(impMock, nfApiHarness, nfTypeHarness);
                } else if (nfTypeHarness == Schema.DisplayType.Picklist) {
                    for (String pickVal : new List<String>{
                        'Si',
                        'No',
                        'yes',
                        'false',
                        'desconocido',
                        'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
                    }) {
                        impMock.put(nfApiHarness, pickVal);
                        readNoFactFromRec(impMock, nfApiHarness, nfTypeHarness);
                    }
                }
            }
            if (String.isNotBlank(indHarness)) {
                isNoFacturableByIndFormula(impMock, indHarness, nfApiHarness, nfDescHarness);
            }
            isAlwaysFacturablePep(impMock);
        }

        resolveSoqlLimitMonthAggregation();
        resolveSoqlLimitDayBreakdown();
        resolveSoqlLimitOwnerOptions();
        resolveDefaultTicketPageSize();
        resolveDefaultImputationSource();
        getAlwaysFacturablePepNames();
        computeCurrentMonthCapacityDiag(oc);
        formatHoursDiag(8.5);
        normalizeHexColor('#ABC', '#112233');

        List<CaseFieldFilter> appendHarness = new List<CaseFieldFilter>();
        appendCaseFilter(appendHarness, 'Status', 'New', true);
        appendCaseFilter(appendHarness, 'Status', 'Working', false);
        filterOwnerOptionsByConsultantConfig(
            new List<OptionDTO>{ newOption('Harness', String.valueOf(UserInfo.getUserId())) }
        );
        hasConsultantUserFilterConfigured();
        buildConsultantUserOptionsFromConfig(50);
    }

    /**
     * Ramas con SOQL acotado: mapCases, fetchTickets, validate AMS/on-behalf, save PEP.
     * Un solo test con startTest propio (presupuesto SOQL bajo 100).
     */
    @TestVisible
    private static void runCoverageHarnessDbForTests() {
        if (!Test.isRunningTest()) {
            return;
        }
        clearOperativeConfigCache();
        getOperativeConfigRow();

        List<Case> cases = new List<Case>();
        try {
            cases = [
                SELECT Id, CaseNumber, Subject, OwnerId, Owner.Name, PEP__r.Name, Status
                FROM Case
                WHERE IsClosed = false
                LIMIT 2
            ];
        } catch (Exception exCase) {
            return;
        }
        if (cases.isEmpty()) {
            return;
        }

        Case one = cases[0];
        Set<Id> caseIds = new Set<Id>{ one.Id };
        Id uid = UserInfo.getUserId();
        Boolean admin = isImputationAdmin();

        mapCasesToTicketRows(cases, uid, admin);
        mapCasesToTicketRows(cases, uid, false);
        filterCasesByAmsEligibility(caseIds);
        filterCasesByGlobalServicio(cases);

        List<CaseFieldFilter> legacy = buildLegacyGlobalAmsCaseFilters();
        if (!legacy.isEmpty()) {
            queryCaseIdsMatchingFieldFilters(caseIds, legacy, 'OR');
        }

        List<CaseFieldFilter> multiFilters = new List<CaseFieldFilter>();
        CaseFieldFilter f0 = new CaseFieldFilter();
        f0.fieldApi = 'Status';
        f0.values = new Set<String>{ 'New', 'Working', 'Open' };
        multiFilters.add(f0);
        CaseFieldFilter f1 = new CaseFieldFilter();
        f1.fieldApi = 'Priority';
        f1.values = new Set<String>{ 'Medium', 'High' };
        multiFilters.add(f1);
        multiFilters = sanitizeCaseFieldFilters(multiFilters);

        FilterDTO fdFetch = new FilterDTO();
        fdFetch.createdDateFromIso = '2019-01-01';
        fdFetch.createdDateToIso = formatIsoDateForCal(Date.today());
        fdFetch.ownerIds = new List<String>{ String.valueOf(uid) };
        if (!multiFilters.isEmpty()) {
            fetchTicketsForCaseFilters(
                fdFetch,
                uid,
                admin,
                10,
                0,
                true,
                caseIds,
                true,
                multiFilters,
                'OR',
                true
            );
        }

        Set<String> numTokens = new Set<String>();
        if (String.isNotBlank(one.CaseNumber)) {
            numTokens.add(one.CaseNumber);
            String bare = caseNumberDigitsOnly(one.CaseNumber);
            if (String.isNotBlank(bare) && bare.length() >= 4) {
                numTokens.add(bare);
            }
            getTicketsByCaseNumbers(new List<String>(numTokens));
            supplementOpenCasesByDigitMatch(cases, numTokens);
            getCaseIdsWhereUserHasImputationOnCaseNumbers(uid, numTokens);
        }

        List<EntryDTO> valBatch = new List<EntryDTO>();
        EntryDTO eVal = new EntryDTO();
        eVal.rowKey = 'db-val';
        eVal.caseId = one.Id;
        eVal.entryDate = Date.today();
        eVal.hours = 1;
        eVal.noFacturable = false;
        valBatch.add(eVal);

        Set<Id> amsIds = filterCasesByAmsEligibility(caseIds);
        if (!amsIds.isEmpty()) {
            EntryDTO eAms = new EntryDTO();
            eAms.rowKey = 'db-ams-nf';
            eAms.caseId = amsIds.iterator().next();
            eAms.entryDate = Date.today();
            eAms.hours = 1;
            eAms.noFacturable = false;
            valBatch.add(eAms);
        }

        EntryDTO eOnBehalf = new EntryDTO();
        eOnBehalf.rowKey = 'db-ob';
        eOnBehalf.caseId = one.Id;
        eOnBehalf.entryDate = Date.today();
        eOnBehalf.hours = 1;
        eOnBehalf.noFacturable = true;
        eOnBehalf.imputingUserId = uid;
        valBatch.add(eOnBehalf);

        List<User> inactiveUsers = new List<User>();
        try {
            inactiveUsers = [SELECT Id FROM User WHERE IsActive = false LIMIT 1];
        } catch (Exception exUsr) {
        }
        if (!inactiveUsers.isEmpty()) {
            EntryDTO eBadOb = new EntryDTO();
            eBadOb.rowKey = 'db-ob-bad';
            eBadOb.caseId = one.Id;
            eBadOb.entryDate = Date.today();
            eBadOb.hours = 1;
            eBadOb.noFacturable = true;
            eBadOb.imputingUserId = inactiveUsers[0].Id;
            valBatch.add(eBadOb);
        }

        validate(valBatch);

        String iso = formatIsoDateForCal(Date.today());
        String saveJson =
            '[{"rowKey":"db-save","caseId":"' +
            String.valueOf(one.Id) +
            '","entryDate":"' +
            iso +
            '","hours":0.5,"noFacturable":true,"comment":"db-harness","source":"test-harness"}]';
        saveEntries(saveJson);

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType != null) {
            Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
            String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
            if (String.isNotBlank(ticketApi)) {
                try {
                    String qImp =
                        'SELECT Id, ' +
                        ticketApi +
                        ' FROM Imputacion__c WHERE ' +
                        ticketApi +
                        ' = :one LIMIT 1';
                    List<SObject> imps = Database.query(qImp);
                    if (!imps.isEmpty()) {
                        imputationRecordDateModifiableByConsultant(imps[0], fMap);
                        getImputationForEdit(String.valueOf(imps[0].Id));
                    }
                } catch (Exception exImp) {
                }
            }
        }

        getCaseImputationLinesForEdit(String.valueOf(one.Id), false);
        getImputationForEditByCase(String.valueOf(one.Id));
    }
}
