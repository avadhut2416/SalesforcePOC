public with sharing class ProcessActualizationDataController {
    @testVisible
    private final static String APAC_TEMPLATE_FILE_NAME = 'APAC_Actualization_Template'; 
    private final static String EMEA_TEMPLATE_FILE_NAME = 'EMEA_Actualization_Template'; 
    private final static String NTAM_SAMPLE_FILE_NAME = 'NTAM_Actualization_Sample'; 
    private final static String BASE_FILE_NAME = 'Actualization_Upload '; 
    private final static Integer BATCH_SIZE = 100; 

    @AuraEnabled
    public static Id processActualizationData(Id excelContentVerId, String scheduleDate, String data, String region){
        try {
            List<ActualizationData> dataList = (List<ActualizationData>)System.JSON.deserialize(data, List<ActualizationData>.class);
            if(region == 'NTAM'){
                return System.enqueueJob(new ActualizationDataQueuable(excelContentVerId,dataList));
            }else{
                Date scheduleDateFormatted = Date.valueOf(scheduleDate + '-01'); //first date of the month
                Id batchId = Database.executeBatch(new ActualizationDataBatch(excelContentVerId, scheduleDateFormatted, dataList, region), BATCH_SIZE);
                    
                return batchId;
            }
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage() + ' | ' +e.getStackTraceString());
        }
    }

    @AuraEnabled
    public static List<Actualization_Job__c> getCurrentActualizationJobByRunningUser(String region) {
        try {
            List<Actualization_Job__c> jobList = [
                SELECT Id, Name, AsyncApexJobId__c, Notify_When_Complete__c, Status__c, 
                Records_To_Process__c, Number_of_Entries__c, format(CreatedDate), format(LastModifiedDate), 
                Monthly_Schedule__c, SucceededRecords__c, FailedRecords__c,
                (SELECT Id FROM AttachedContentDocuments),
                (SELECT Payload__c FROM Actualization_Entries__r)
                FROM Actualization_Job__c
                WHERE Status__c != ''
                AND AsyncApexJobId__c != ''
                AND Region__c =: region
                AND CreatedById = :UserInfo.getUserId()
                ORDER BY CreatedDate DESC
                LIMIT 1
            ];

            return jobList;
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage());
        }
    }

    
    @AuraEnabled
    public static List<Actualization_Job__c> getActualizationJobByApexId(Id jobId){
        try {
            List<Actualization_Job__c> jobList = [
                SELECT Id, Name, Notify_When_Complete__c, AsyncApexJobId__c, Status__c, Status_Detail__c, 
                Records_To_Process__c, Number_of_Entries__c, Monthly_Schedule__c, format(CreatedDate), format(LastModifiedDate),
                SucceededRecords__c, FailedRecords__c,
                (SELECT Id, ContentDocumentId FROM AttachedContentDocuments),
                (SELECT Payload__c FROM Actualization_Entries__r)
                FROM Actualization_Job__c
                WHERE AsyncApexJobId__c =: jobId
                LIMIT 1
            ];
            return jobList;
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage());
        }
    }

    @AuraEnabled
    public static list<Actualization_Entry__c> getActualizationJobEntries(Id actualizationJobId){
        try { 
            List<Actualization_Entry__c> actualizationEntries = [
                SELECT Id, Payload__c
                FROM Actualization_Entry__c
                WHERE Actualization_Job__c = :actualizationJobId
            ];

            return actualizationEntries;
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage());
        }
    }
        
    @AuraEnabled
    public static Id uploadNewFileVersion(String fileDataJSON, String region) {
        if (fileDataJSON == null) {
            throw new AuraHandledException('No data to upload');
        }
        try {
            FileData fileData = (FileData)JSON.deserialize(fileDataJSON, FileData.class);
            Blob fileBody = EncodingUtil.base64Decode(fileData.base64);
            ContentVersion contentVersion = new ContentVersion(
                VersionData = fileBody,
                PathOnClient = fileData.pathOnClient,
                Title = region + '_' + BASE_FILE_NAME + String.valueOf(DateTime.now())
            );  
            Database.insert(contentVersion);
            return contentVersion.Id;
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage());
        }
    }

    @AuraEnabled
    public static ContentDocument getDefaultActualizationFile(String region) {
        String fileName = (region == 'APAC' ? APAC_TEMPLATE_FILE_NAME : (region == 'EMEA' ? EMEA_TEMPLATE_FILE_NAME : NTAM_SAMPLE_FILE_NAME));
        try {
            ContentDocument contentDocument = [
                SELECT Id, FileType 
                FROM ContentDocument
                WHERE Title = :fileName LIMIT 1
            ];
            return contentDocument;
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException('The ' + Region + ' Sample/Template File does not exist.');
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<Actualization_Job__c> getRecentJobs(String region) {
        try {
            return [
                SELECT Id, Name, AsyncApexJobId__c, Status__c, Records_To_Process__c, Number_of_Entries__c, format(CreatedDate), 
                Monthly_Schedule__c, CreatedById, CreatedBy.Name, SucceededRecords__c, FailedRecords__c
                FROM Actualization_Job__c
                WHERE Region__c =: region
                ORDER BY CreatedDate DESC
                LIMIT 100
            ];
        } catch (Exception e) {
            ErrorLogger.logError(e, ErrorLogger.SourceType.Apex);
            throw new AuraHandledException(e.getMessage());
        }
    }

    public class FileData {
        @AuraEnabled public String base64; 
        @AuraEnabled public String pathOnClient;
   }
}