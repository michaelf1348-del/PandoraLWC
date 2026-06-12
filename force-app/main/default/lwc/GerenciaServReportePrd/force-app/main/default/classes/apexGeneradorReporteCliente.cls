public with sharing class GestorReportesClienteController {
    
    @AuraEnabled
    public static ReporteDinamicoDTO obtenerDatosReporte(Id recordId, String reportDevName) {
        try {
            ReporteDinamicoDTO dto = new ReporteDinamicoDTO();
            String sObjName = recordId.getSObjectType().getDescribe().getName();
            
            // 1. Nombre dinámico del Cliente/Proyecto
            if (sObjName == 'Case') {
                Case c = [SELECT Account.Name FROM Case WHERE Id = :recordId LIMIT 1];
                dto.nombreProyecto = c.Account.Name;
            } else if (sObjName == 'Account') {
                Account acc = [SELECT Name FROM Account WHERE Id = :recordId LIMIT 1];
                dto.nombreProyecto = acc.Name;
            } else {
                dto.nombreProyecto = 'Proyecto AMS';
            }
            
            // 2. Conexión a la API de Reportes
            Report rep = [SELECT Id FROM Report WHERE DeveloperName = :reportDevName LIMIT 1];
            Reports.ReportResults results = Reports.ReportManager.runReport(rep.Id, true);
            Reports.ReportMetadata metadata = results.getReportMetadata();
            
            // 3. Extraer Columnas
            dto.columnas = new List<String>();
            Map<String, Reports.DetailColumn> detailColumnInfo = results.getReportExtendedMetadata().getDetailColumnInfo();
            for (String colName : metadata.getDetailColumns()) {
                dto.columnas.add(detailColumnInfo.get(colName).getLabel());
            }
            
            // 4. Extraer Filas
            dto.filas = new List<List<String>>();
            Reports.ReportFactWithDetails factDetails = (Reports.ReportFactWithDetails)results.getFactMap().get('T!T');
            
            if (factDetails != null && factDetails.getRows() != null) {
                for (Reports.ReportDetailRow row : factDetails.getRows()) {
                    List<String> rowData = new List<String>();
                    for (Reports.ReportDataCell cell : row.getDataCells()) {
                        rowData.add(cell.getLabel()); 
                    }
                    dto.filas.add(rowData);
                }
            }
            
            return dto;
        } catch (Exception e) {
            throw new AuraHandledException('Error en API de Reportes: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String guardarReporte(Id recordId, String fileName, String base64Data) {
        try {
            ContentVersion cv = new ContentVersion();
            cv.Title = fileName;
            cv.PathOnClient = fileName;
            cv.VersionData = EncodingUtil.base64Decode(base64Data);
            cv.IsMajorVersion = true;
            insert cv;

            Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;

            ContentDocumentLink cdl = new ContentDocumentLink();
            cdl.ContentDocumentId = conDocId;
            cdl.LinkedEntityId = recordId;
            cdl.ShareType = 'V';
            cdl.Visibility = 'AllUsers';
            insert cdl;

            return conDocId;
        } catch (Exception e) {
            throw new AuraHandledException('Error guardando archivo: ' + e.getMessage());
        }
    }

    public class ReporteDinamicoDTO {
        @AuraEnabled public String nombreProyecto;
        @AuraEnabled public List<String> columnas;
        @AuraEnabled public List<List<String>> filas;
    }
}