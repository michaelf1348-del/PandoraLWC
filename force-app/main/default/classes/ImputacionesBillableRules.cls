/**
 * Evaluacion de criterios facturable / no facturable (JSON del centro operativo).
 */
public with sharing class ImputacionesBillableRules {
    public class ExtraFilterRule {
        public String objectApi;
        public String fieldApi;
        public Set<String> values;
        public String effect;
    }

    public class RulesConfig {
        public String caseNoFactField;
        public Set<String> caseNoFactValues;
        public String caseExcField;
        public Set<String> caseExcValues;
        public String imputacionIndField;
        public Set<String> imputacionFactValues;
        public Set<String> imputacionNoFactValues;
        public String imputacionExcField;
        public Set<String> imputacionExcValues;
        public List<ExtraFilterRule> extraFilters;
    }

    public class EvaluateInput {
        public SObject imputation;
        public Case caseRow;
        public Boolean amsManagementCase;
        public Boolean plannedNoFacturable;
        public Boolean nfCheckbox;
        public Boolean alwaysFacturablePep;
    }

    private static RulesConfig cachedRules;
    private static Boolean rulesLoaded = false;

    public static void clearCache() {
        rulesLoaded = false;
        cachedRules = null;
    }

    public static RulesConfig loadFromOperativeConfig(Configurar_Centro_Imputaciones__c oc) {
        if (rulesLoaded) {
            return cachedRules;
        }
        rulesLoaded = true;
        cachedRules = parseJson(oc == null ? null : oc.Criterios_Facturable_Filtros_JSON__c);
        return cachedRules;
    }

    public static RulesConfig parseJson(String rawJson) {
        if (String.isBlank(rawJson)) {
            return emptyRules();
        }
        RulesConfig cfg = emptyRules();
        try {
            Object parsed = JSON.deserializeUntyped(rawJson);
            if (!(parsed instanceof Map<String, Object>)) {
                return cfg;
            }
            Map<String, Object> root = (Map<String, Object>) parsed;
            readCaseRule(root, 'caseNoFacturable', cfg, true);
            readCaseRule(root, 'caseExcepcionFacturable', cfg, false);
            readImputacionExc(root, cfg);
            if (root.containsKey('imputacionIndField') && root.get('imputacionIndField') != null) {
                cfg.imputacionIndField = String.valueOf(root.get('imputacionIndField')).trim();
            }
            if (root.containsKey('imputacionFacturableValues')) {
                cfg.imputacionFactValues = parseValueList(String.valueOf(root.get('imputacionFacturableValues')));
            }
            if (root.containsKey('imputacionNoFacturableValues')) {
                cfg.imputacionNoFactValues = parseValueList(String.valueOf(root.get('imputacionNoFacturableValues')));
            }
            if (root.containsKey('extraFilters') && root.get('extraFilters') instanceof List<Object>) {
                List<Object> extras = (List<Object>) root.get('extraFilters');
                for (Object item : extras) {
                    if (!(item instanceof Map<String, Object>) || cfg.extraFilters.size() >= 8) {
                        continue;
                    }
                    Map<String, Object> f = (Map<String, Object>) item;
                    ExtraFilterRule er = new ExtraFilterRule();
                    er.objectApi = f.containsKey('objectApi') ? String.valueOf(f.get('objectApi')).trim() : 'Case';
                    er.fieldApi = f.containsKey('fieldApi') ? String.valueOf(f.get('fieldApi')).trim() : '';
                    er.values = parseValueList(f.containsKey('values') ? String.valueOf(f.get('values')) : '');
                    er.effect = f.containsKey('effect') ? String.valueOf(f.get('effect')).trim() : 'excepcionFacturable';
                    if (String.isNotBlank(er.fieldApi)) {
                        cfg.extraFilters.add(er);
                    }
                }
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'ImputacionesBillableRules.parseJson: ' + ex.getMessage());
        }
        return cfg;
    }

    private static void readCaseRule(
        Map<String, Object> root,
        String key,
        RulesConfig cfg,
        Boolean noFacturable
    ) {
        if (!root.containsKey(key) || !(root.get(key) instanceof Map<String, Object>)) {
            return;
        }
        Map<String, Object> block = (Map<String, Object>) root.get(key);
        String fieldApi = block.containsKey('fieldApi') ? String.valueOf(block.get('fieldApi')).trim() : '';
        Set<String> values = parseValueList(block.containsKey('values') ? String.valueOf(block.get('values')) : '');
        if (noFacturable) {
            cfg.caseNoFactField = fieldApi;
            cfg.caseNoFactValues = values;
        } else {
            cfg.caseExcField = fieldApi;
            cfg.caseExcValues = values;
        }
    }

    private static void readImputacionExc(Map<String, Object> root, RulesConfig cfg) {
        if (
            !root.containsKey('imputacionExcepcionFacturable') ||
            !(root.get('imputacionExcepcionFacturable') instanceof Map<String, Object>)
        ) {
            return;
        }
        Map<String, Object> block = (Map<String, Object>) root.get('imputacionExcepcionFacturable');
        cfg.imputacionExcField = block.containsKey('fieldApi') ? String.valueOf(block.get('fieldApi')).trim() : '';
        cfg.imputacionExcValues = parseValueList(block.containsKey('values') ? String.valueOf(block.get('values')) : '');
    }

    public static RulesConfig defaultRules() {
        return emptyRules();
    }

    /** Sin reglas en JSON: solo indicador de imputacion si esta configurado. */
    public static RulesConfig emptyRules() {
        RulesConfig cfg = new RulesConfig();
        cfg.caseNoFactField = '';
        cfg.caseNoFactValues = new Set<String>();
        cfg.caseExcField = '';
        cfg.caseExcValues = new Set<String>();
        cfg.imputacionIndField = '';
        cfg.imputacionFactValues = new Set<String>();
        cfg.imputacionNoFactValues = new Set<String>();
        cfg.imputacionExcField = '';
        cfg.imputacionExcValues = new Set<String>();
        cfg.extraFilters = new List<ExtraFilterRule>();
        return cfg;
    }

    public static Set<String> parseValueList(String raw) {
        Set<String> out = new Set<String>();
        if (String.isBlank(raw)) {
            return out;
        }
        for (String part : raw.split('[;,\\n]+')) {
            String t = part == null ? '' : part.trim();
            if (String.isNotBlank(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** Campos Case accesibles necesarios para evaluar reglas. */
    public static Set<String> collectCaseFieldApis(RulesConfig rules) {
        Set<String> apis = new Set<String>();
        if (rules == null) {
            return apis;
        }
        addValidatedCaseField(apis, rules.caseNoFactField);
        addValidatedCaseField(apis, rules.caseExcField);
        for (ExtraFilterRule f : rules.extraFilters) {
            if (f != null && 'Case'.equalsIgnoreCase(f.objectApi)) {
                addValidatedCaseField(apis, f.fieldApi);
            }
        }
        return apis;
    }

    /** Campos Imputacion__c accesibles necesarios para evaluar reglas. */
    public static Set<String> collectImputationFieldApis(
        RulesConfig rules,
        Map<String, Schema.SObjectField> impFieldMap
    ) {
        Set<String> apis = new Set<String>();
        if (rules == null || impFieldMap == null) {
            return apis;
        }
        addValidatedImpField(apis, rules.imputacionIndField, impFieldMap);
        addValidatedImpField(apis, rules.imputacionExcField, impFieldMap);
        for (ExtraFilterRule f : rules.extraFilters) {
            if (f != null && 'Imputacion__c'.equalsIgnoreCase(f.objectApi)) {
                addValidatedImpField(apis, f.fieldApi, impFieldMap);
            }
        }
        return apis;
    }

    private static void addValidatedCaseField(Set<String> apis, String fieldApi) {
        if (String.isBlank(fieldApi)) {
            return;
        }
        Map<String, Schema.SObjectField> caseFm = Case.SObjectType.getDescribe().fields.getMap();
        if (caseFm.containsKey(fieldApi) && caseFm.get(fieldApi).getDescribe().isAccessible()) {
            apis.add(fieldApi);
        }
    }

    private static void addValidatedImpField(
        Set<String> apis,
        String fieldApi,
        Map<String, Schema.SObjectField> impFieldMap
    ) {
        if (String.isBlank(fieldApi) || impFieldMap == null) {
            return;
        }
        if (impFieldMap.containsKey(fieldApi) && impFieldMap.get(fieldApi).getDescribe().isAccessible()) {
            apis.add(fieldApi);
        }
    }

    public static String serializeCaseRuleFields(Case c, Set<String> fieldApis) {
        Map<String, String> out = new Map<String, String>();
        if (c == null || fieldApis == null) {
            return JSON.serialize(out);
        }
        for (String api : fieldApis) {
            out.put(api, readFieldAsMatchString(c, api));
        }
        return JSON.serialize(out);
    }

    public static String readFieldAsMatchString(SObject rec, String fieldApi) {
        if (rec == null || String.isBlank(fieldApi)) {
            return '';
        }
        try {
            Object v = rec.get(fieldApi);
            if (v == null) {
                return '';
            }
            if (v instanceof Boolean) {
                return ((Boolean) v) ? 'true' : 'false';
            }
            return String.valueOf(v).trim();
        } catch (Exception ex) {
            return '';
        }
    }

    public static Boolean valueMatchesList(String raw, Set<String> allowed) {
        if (allowed == null || allowed.isEmpty() || String.isBlank(raw)) {
            return false;
        }
        String s = raw.trim();
        for (String token : allowed) {
            if (String.isBlank(token)) {
                continue;
            }
            if (s.equalsIgnoreCase(token.trim())) {
                return true;
            }
            if (s.contains(';')) {
                for (String part : s.split(';')) {
                    if (part != null && part.trim().equalsIgnoreCase(token.trim())) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /** true = horas no facturables; false = facturables. */
    public static Boolean evaluateIsNoFacturable(EvaluateInput input, RulesConfig rules) {
        if (input == null) {
            return false;
        }
        if (input.alwaysFacturablePep == true) {
            return false;
        }

        RulesConfig cfg = rules != null ? rules : defaultRules();

        if (matchesImputationException(input.imputation, cfg)) {
            return false;
        }
        if (matchesCaseException(input.caseRow, cfg)) {
            return false;
        }
        String extraExc = matchExtraEffect(input, cfg, 'excepcionFacturable');
        if (extraExc == 'excepcionFacturable') {
            return false;
        }

        String extraNf = matchExtraEffect(input, cfg, 'noFacturable');
        if (extraNf == 'noFacturable') {
            return true;
        }

        if (matchesCaseNoFacturable(input, cfg, input.amsManagementCase)) {
            return true;
        }

        String indOutcome = evaluateIndField(input.imputation, cfg);
        if (indOutcome == 'NF') {
            return true;
        }
        if (indOutcome == 'FA') {
            return false;
        }

        if (input.plannedNoFacturable == true || input.nfCheckbox == true) {
            return true;
        }

        String extraFac = matchExtraEffect(input, cfg, 'facturable');
        if (extraFac == 'facturable') {
            return false;
        }

        return false;
    }

    private static Boolean matchesImputationException(SObject imp, RulesConfig cfg) {
        if (imp == null || cfg == null || String.isBlank(cfg.imputacionExcField)) {
            return false;
        }
        return valueMatchesList(readFieldAsMatchString(imp, cfg.imputacionExcField), cfg.imputacionExcValues);
    }

    private static Boolean matchesCaseException(Case c, RulesConfig cfg) {
        if (c == null || cfg == null || String.isBlank(cfg.caseExcField)) {
            return false;
        }
        return valueMatchesList(readFieldAsMatchString(c, cfg.caseExcField), cfg.caseExcValues);
    }

    private static Boolean matchesCaseNoFacturable(EvaluateInput input, RulesConfig cfg, Boolean amsFallback) {
        Case c = input == null ? null : input.caseRow;
        if (cfg != null && String.isNotBlank(cfg.caseNoFactField) && !cfg.caseNoFactValues.isEmpty()) {
            if (c != null && valueMatchesList(readFieldAsMatchString(c, cfg.caseNoFactField), cfg.caseNoFactValues)) {
                return true;
            }
        }
        return amsFallback == true;
    }

    private static String evaluateIndField(SObject imp, RulesConfig cfg) {
        if (imp == null || cfg == null || String.isBlank(cfg.imputacionIndField)) {
            return null;
        }
        String indStr = readFieldAsMatchString(imp, cfg.imputacionIndField).toUpperCase();
        if (String.isBlank(indStr)) {
            return null;
        }
        for (String nf : cfg.imputacionNoFactValues) {
            if (indStr == nf.trim().toUpperCase()) {
                return 'NF';
            }
        }
        for (String fa : cfg.imputacionFactValues) {
            if (indStr == fa.trim().toUpperCase()) {
                return 'FA';
            }
        }
        return null;
    }

    private static String matchExtraEffect(EvaluateInput input, RulesConfig cfg, String wantedEffect) {
        if (cfg == null || cfg.extraFilters == null) {
            return null;
        }
        for (ExtraFilterRule f : cfg.extraFilters) {
            if (f == null || f.effect != wantedEffect) {
                continue;
            }
            SObject rec = null;
            if ('Case'.equalsIgnoreCase(f.objectApi)) {
                rec = input.caseRow;
            } else if ('Imputacion__c'.equalsIgnoreCase(f.objectApi)) {
                rec = input.imputation;
            }
            if (rec != null && valueMatchesList(readFieldAsMatchString(rec, f.fieldApi), f.values)) {
                return f.effect;
            }
        }
        return null;
    }

    /** Ticket bloqueado como no facturable en tabla (sin excepcion Case). */
    public static Boolean caseForcedNoFacturable(Case c, Boolean amsManagementCase, RulesConfig rules) {
        EvaluateInput ev = new EvaluateInput();
        ev.caseRow = c;
        ev.amsManagementCase = amsManagementCase;
        RulesConfig cfg = rules != null ? rules : defaultRules();
        if (matchesCaseException(c, cfg)) {
            return false;
        }
        return matchesCaseNoFacturable(ev, cfg, amsManagementCase);
    }
}
