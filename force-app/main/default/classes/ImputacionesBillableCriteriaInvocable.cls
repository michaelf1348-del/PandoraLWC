/**
 * Para Flow / proceso admin: actualizar el JSON fijo de criterios facturables del centro
 * cuando cambie la definicion de Ind_Imputacion__c en Setup (no en cada imputacion).
 */
public with sharing class ImputacionesBillableCriteriaInvocable {
    public class Request {
        @InvocableVariable(
            required=true
            label='JSON criterios facturables'
            description='Contenido de Criterios_Facturable_Filtros_JSON__c (mismo criterio que Ind_Imputacion__c).'
        )
        public String billableCriteriaFiltersJson;
    }

    public class Result {
        @InvocableVariable(label='Exito')
        public Boolean success;
        @InvocableVariable(label='Mensaje')
        public String message;
    }

    @InvocableMethod(
        label='Actualizar JSON criterios facturables del centro'
        description='Escribe el JSON en Configurar_Centro_Imputaciones__c (DEFAULT) y limpia cache de reglas.'
    )
    public static List<Result> updateBillableCriteriaJson(List<Request> requests) {
        List<Result> out = new List<Result>();
        Result r = new Result();
        r.success = false;
        out.add(r);

        if (requests == null || requests.isEmpty() || String.isBlank(requests[0].billableCriteriaFiltersJson)) {
            r.message = 'JSON vacio.';
            return out;
        }

        Configurar_Centro_Imputaciones__c oc = ImputacionesOperativeConfigLoader.loadDefault();
        if (oc == null || oc.Id == null) {
            r.message = 'No existe registro operativo DEFAULT en Configurar_Centro_Imputaciones__c.';
            return out;
        }

        try {
            oc.Criterios_Facturable_Filtros_JSON__c = requests[0].billableCriteriaFiltersJson.trim();
            update oc;
            ImputacionesAMSController.clearOperativeConfigCache();
            ImputacionesBillableRules.clearCache();
            r.success = true;
            r.message = 'JSON actualizado.';
        } catch (Exception ex) {
            r.message = ex.getMessage();
        }
        return out;
    }
}
