/**
 * @description Controlador para la lista relacionada personalizada de Tickets (Case).
 * Solo expone consultas necesarias para alimentar el lightning-datatable del LWC `ticketRelatedList`.
 *
 * @group Tickets
 */
public with sharing class TicketController {

    /**
     * @description Devuelve los tickets (Case) asociados a una cuenta, ordenados por fecha desc.
     * Cacheable=true permite que el wire del LWC refresque eficientemente sin re-ejecutar la query.
     *
     * @param accountId Id de la cuenta padre.
     * @return Lista de casos con los campos necesarios para el datatable.
     */
    @AuraEnabled(cacheable=true)
    public static List<TicketWrapper> getTicketsByAccount(Id accountId) {
        List<TicketWrapper> result = new List<TicketWrapper>();
        if (accountId == null) {
            return result;
        }

        // SECURITY_ENFORCED respeta CRUD/FLS del usuario sin necesidad de stripInaccessible adicional.
        List<Case> cases = [
            SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, RecordType.Name
            FROM Case
            WHERE AccountId = :accountId
            WITH SECURITY_ENFORCED
            ORDER BY CreatedDate DESC
            LIMIT 200
        ];

        for (Case c : cases) {
            result.add(new TicketWrapper(c));
        }
        return result;
    }

    /**
     * @description DTO plano para evitar mandar el SObject completo y aplanar RecordType.Name.
     * El datatable trabaja mejor con objetos planos (sin relaciones anidadas).
     */
    public class TicketWrapper {
        @AuraEnabled public Id Id;
        @AuraEnabled public String CaseNumber;
        @AuraEnabled public String Subject;
        @AuraEnabled public String Status;
        @AuraEnabled public String Priority;
        @AuraEnabled public Datetime CreatedDate;
        @AuraEnabled public String RecordTypeName;
        @AuraEnabled public String CaseUrl;

        public TicketWrapper(Case c) {
            this.Id = c.Id;
            this.CaseNumber = c.CaseNumber;
            this.Subject = c.Subject;
            this.Status = c.Status;
            this.Priority = c.Priority;
            this.CreatedDate = c.CreatedDate;
            this.RecordTypeName = (c.RecordType != null) ? c.RecordType.Name : '';
            this.CaseUrl = '/' + c.Id;
        }
    }
}
