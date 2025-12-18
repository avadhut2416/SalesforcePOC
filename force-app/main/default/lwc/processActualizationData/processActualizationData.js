import { track, wire} from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import { updateRecord, getRecord} from 'lightning/uiRecordApi';
import NOTIFY_WHEN_COMPLETE_FIELD from '@salesforce/schema/Actualization_Job__c.Notify_When_Complete__c';

import LightningElementWithErrorHandlers from 'c/lightningElementWithErrorHandlers';
import processActualizationData from '@salesforce/apex/ProcessActualizationDataController.processActualizationData';
import getCurrentActualizationJobByRunningUser from '@salesforce/apex/ProcessActualizationDataController.getCurrentActualizationJobByRunningUser';
import getActualizationJobByApexId from '@salesforce/apex/ProcessActualizationDataController.getActualizationJobByApexId';
import getDefaultActualizationFile from '@salesforce/apex/ProcessActualizationDataController.getDefaultActualizationFile';
import getActualizationJobEntries from '@salesforce/apex/ProcessActualizationDataController.getActualizationJobEntries';
import processActualizationUpload from 'c/processActualizationUpload';
import userId from '@salesforce/user/Id';

import { NavigationMixin } from "lightning/navigation";

const apacCols = [
    { label: 'Clicks', fieldName: 'Clicks', type: 'number' },
    { label: 'Views', fieldName: 'Views', type: 'number' },
    { label: 'Completed Views', fieldName: 'CompletedViews', type: 'number' },
    { label: 'Conversions', fieldName: 'Conversions', type: 'number' },
    { label: 'Impressions', fieldName: 'Impressions', type: 'number' },
    { label: 'Budget', fieldName: 'Budget', type: 'number' },
    { label: 'Cost', fieldName: 'Cost', type: 'number' },
    { label: 'Currency ISO Code', fieldName: 'CurrencyISOCode' },
    { label: 'DSP', fieldName: 'DSP' }
];   

const ntamCols = [
    { label: 'Actualized Billable Units', fieldName: 'billableUnits', type: 'number' },
    { label: 'Actualized Billable Spend', fieldName: 'billableSpend', type: 'currency' },
    { label: 'Actualized Payable Units', fieldName: 'payableUnits', type: 'number' },
    { label: 'Actualized Payable Spend', fieldName: 'payableSpend', type: 'currency' }
];  

const emeaCols = [
    { label: 'Quantity', fieldName: 'Quantity', type: 'number' },
    { label: 'Planned Gross Budget', fieldName: 'Budget', type: 'currency' },
    { label: 'Costs', fieldName: 'Cost', type: 'currency' }
];  

const ActualizationState = Object.freeze({
    PENDING: 'pending',
    PREVIEW: 'preview',
    IN_PROGRESS: 'in_Progress',
    COMPLETE: 'complete'
})

export default class ProcessActualizationData extends NavigationMixin(LightningElementWithErrorHandlers) {
    @track actualizationData = [];
    @track actualizationResults = [];
    @track filteredActualizationResults = [];
    @track defaultActualizationFile;
    @track fileDownloadLabel;

    columns;
    isLoading = false;
    batchJobId = null;
    executedPercentage = 0;
    executedIndicator = 0;
    isBatchCompleted = false;
    totalRecords = 0;
    executedRecords = 0;
    numOfRecordsToProcess = 0;
    scheduleDate;
    jobStatusDetails = '';
    isJobStarted = false;
    selectedOption = 'all';
    excelContentVerId;

    runningUsersRegion; // Region defined on User Record
    @track runningRegion; // Region by which the Actualization Tool runs
    runningUserIsGlobal = false; 
    contentVersionId;
    recordCount=0;

    _csvResultFileId;
    _currentActualizationJob;
    _isJobFailed = false;
    _interval;
    _runningJobStatuses = ['Queued', 'Preparing', 'Running'];
    _refreshInterValTime = 5000;
    _isNotifyWhenComplete = false;
    _processState = ActualizationState.PENDING;

    @wire(getRecord, { recordId: userId,fields:'User.Region__c'})
    userDetails ({ error, data }) {
        if(error) {} else if (data) {
            if(!this.runningUsersRegion){
                this.runningUsersRegion = data.fields.Region__c.value;
                if(this.runningUsersRegion === 'Global'){
                    this.runningUserIsGlobal = true;
                }else{
                    this.runningRegion = this.runningUsersRegion;
                    this._prepareActualizationToolForRegion();
                }
            }
        }
    }

    get hasActualizationResults() {
        return this.actualizationResults?.length > 0
    }

    get hasFilteredResults() {
        return this.filteredActualizationResults?.length > 0
    }

    get disableStartProcessBtn() {
        return this.actualizationData?.length == 0 || this.hasRunningJob || this.isJobStarted; 
    }

    get disableUploadBtn() {
        return this.hasRunningJob || this.isJobStarted; 
    }

    get hasRunningJob() {
        return this._runningJobStatuses.includes(this._currentActualizationJob?.Status__c);
    }

    set isNotifyWhenComplete(value) {
        this._isNotifyWhenComplete = value; 
    }
    get isNotifyWhenComplete() {
        return (this._currentActualizationJob !== undefined ? this._currentActualizationJob.Notify_When_Complete__c : false) || this._isNotifyWhenComplete;
    }

    get showResultsComponent() {
        return (
            this._processState == ActualizationState.PREVIEW || 
            this._processState == ActualizationState.COMPLETE
        ) && this.hasActualizationResults;
    }

    get jobIsNotComplete() {
        return this._processState != ActualizationState.COMPLETE;
    }

    get noSuccessRecords() {
        return this._currentActualizationJob?.SucceededRecords__c ?? 0;
    }

    get noErrorRecords() {
        return this._currentActualizationJob?.FailedRecords__c ?? 0;
    }

    get options() {
        return [
            { label: 'All Records', value: 'all' },
            { label: 'Succeeded Records', value: "true" },
            { label: 'Failed Records', value: "false" }
        ];
    }

    runningRegion = 'Global';

    get regionSelctionOptions() {
        return [
            { label: 'APAC', value: 'APAC' },
            { label: 'NTAM', value: 'NTAM' },
            { label: 'EMEA', value: 'EMEA' },
        ];
    }
    connectedCallback() {
    subscribe('/event/File_Uploaded_Event__e', -1, message => {
        
        // 1. Read values from Platform Event
        this.contentVersionId = message.data.payload.ContentVersionId__c;
        this.actualizationData = JSON.parse(message.data.payload.FileData__c);
        this.recordCount = message.data.payload.RecordCount__c;
        this.runningRegion = 'APAC';

        // 2. Prepare preview columns
        let firstCol = { label: 'Sell Line', fieldName: 'SellLine' };
        this.columns = [firstCol, ...this._getColumnsForRegion('APAC')];

        // 3. Set preview table data
        this.actualizationResults = this.actualizationData;
        this.filteredActualizationResults = this.actualizationResults;
        this.numOfRecordsToProcess = this.recordCount;
        this.scheduleDate = new Date().toISOString().substring(0, 7); 

        // 4. Switch UI to PREVIEW mode
        this.actualizationTableTitle = 'Actualization Preview';
        this._processState = 'preview';
        
        this.showToast(
            'Success', 
            `File uploaded successfully. ${this.recordCount} records ready for preview.`,
            'success'
        );

    }).then(response => {
        this.subscription = response;
    });

    onError(error => console.error(error));
}


    disconnectedCallback() {
		// it's needed for the case the component gets disconnected
		clearInterval(this._interval);
	}

    _getCurrentActualizationJob() {
        getCurrentActualizationJobByRunningUser().then(res => {
            this._currentActualizationJob = res[0];
            if (this._currentActualizationJob.Status__c === 'Running') {
                this.isJobStarted = true;
                this.batchJobId = this._currentActualizationJob.AsyncApexJobId__c;
                this.showToast('Warning', 'There is a running actualization job. Please wait for the job to complete.', 'warning');
                this._refreshBatchOnInterval();
                this.jobStatusDetails = this._currentActualizationJob.Status_Detail__c != null ?  this._currentActualizationJob.Status_Detail__c : this.jobStatusDetails;
                this.scheduleDate = this._currentActualizationJob.Monthly_Schedule__c;
                this._setResultsTableAttributes();
                this._setActualizationResults();
                this._setProgressBarValue(this._currentActualizationJob);
            }
        }).catch(error => {
            this.handleError(error);
        });
    }

    _getActualizationJobStatus() {
        getActualizationJobByApexId({jobId :this.batchJobId}).then(res => {
            if (res[0]) {
                this.isLoading = false;
                this._currentActualizationJob = res[0];
                this.scheduleDate = this._currentActualizationJob.Monthly_Schedule__c;
                this.jobStatusDetails = this._currentActualizationJob.Status_Detail__c != null ?  this._currentActualizationJob.Status_Detail__c : this.jobStatusDetails;
                   if (this._currentActualizationJob.Status__c === 'Running') {
                    this._setProgressBarValue(this._currentActualizationJob);
                } else if (this._currentActualizationJob.Status__c === 'Completed') {
                    this._setProgressBarValue(this._currentActualizationJob);
                    this.isBatchCompleted = true;
                    this._csvResultFileId = this._currentActualizationJob.AttachedContentDocuments[0].ContentDocumentId || this._currentActualizationJob.Id;
                    this._setActualizationResults();
                    this.jobStatusDetails = 'Actualization Job completed.';
                    this._processState = ActualizationState.COMPLETE;
                    this.showToast('Success', 'The actualization job is completed. Please check the results below.', 'success');
                } else {
                    this.handleError('The Acualization Job failed. ' + this._currentActualizationJob.Status_Detail__c + 
                        'Ask your System Administrator to check the logs.');
                    this._isJobFailed = true;
                    this.handleStartNewJob();
                }
            }
        }).catch(error => {
            this.isLoading = false;
            this.handleError(error);
        });
    }

    _getDefaultExcelFile() {
        getDefaultActualizationFile({ region: this.runningRegion}).then(res => {
            this.defaultActualizationFile = res;
        }).catch(error => {
            this.handleError(error);
        });
    }

    _getColumnsForRegion(region) {
        switch (region) {
            case 'NTAM':
                return ntamCols;
            case 'EMEA':
                return emeaCols;
            default:
                return apacCols;
        }
    }


    async handleUploadActualizationTemplate() {
            let result = await processActualizationUpload.open({
                size: "small",
                region: this.runningRegion
            });

            if (result) {

                // SET TABLE COLUMNS DEPENDING ON REGION
                let firstCol = this.runningRegion === 'NTAM'
                    ? { label: 'SF CAMPAIGN ID', fieldName: 'campaignID' }
                    : { label: 'Sell Line', fieldName: 'SellLine' };

                this.columns = [firstCol, ...this._getColumnsForRegion(this.runningRegion)];

              
                this.actualizationData = result.actualizationData;
                this.actualizationResults = result.actualizationData;
                this.scheduleDate = result.scheduleDate;
                this.excelContentVerId = result.excelContentVerId;
                this.numOfRecordsToProcess = result.actualizationData.length;
                this.filteredActualizationResults = this.actualizationResults;
                this.actualizationTableTitle = 'Actualization Preview';
                this.isBatchCompleted = false;
                this._processState = 'preview';
            }
        }


    async handleStartActualization() {
        this.isLoading = true;
        this._setResultsTableAttributes();    
        await processActualizationData({excelContentVerId: this.excelContentVerId, scheduleDate: this.scheduleDate, data: JSON.stringify(this.actualizationData), region: this.runningRegion})
        .then(result => {
            if (result) {
                this.jobStatusDetails = 'Preparing';
                this.isJobStarted = true;
                this.batchJobId = result;
                this._refreshBatchOnInterval();
                this._getActualizationJobStatus();
                this.isLoading = false;
                this._processState = ActualizationState.IN_PROGRESS;
            }
        })
        .catch(error => {
            this.handleError(error);
            this.disableStartProcessBtn = false;
            this.isLoading = false;
        });

    }

    showToast(title, message, variant) {
        const event = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant,
        });
        this.dispatchEvent(event);
    }

    _refreshBatchOnInterval() {
        this._interval = setInterval(() => {
            if (this.isBatchCompleted || this._isJobFailed) {
                clearInterval(this._interval);
            } else {
                this._getActualizationJobStatus();
            }
        }, this._refreshInterValTime);
    }

    openResultURL() {
        this._navigateTo(this._csvResultFileId);
    }

    handleDownloadTemplate() {
        this._navigateTo(this.defaultActualizationFile.Id);
    }

    handleStartNewJob() {
        this.actualizationData = [];
        this.actualizationResults = [];
        this.batchJobId = null;
        this.executedPercentage = 0;
        this.executedIndicator = 0;
        this.isBatchCompleted = false;
        this.totalRecords = 0;
        this.executedRecords = 0;
        this.numOfRecordsToProcess = 0;
        this.scheduleDate = '';
        this.isJobStarted = false;
        this.resetFilters();
        this.isNotifyWhenComplete = false;
    }

    _navigateTo(id) {
        if (id) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: {
                    recordId: id,
                    actionName: 'view'
                }
            });  
        } else {
            this.handleError('No result URL available!');
        }      
    }

    _setProgressBarValue(result) {
        this.executedRecords = result.Number_of_Entries__c || 0;
        this.numOfRecordsToProcess = result.Records_To_Process__c || 0;
        this.executedPercentage = ((this.executedRecords / result.Records_To_Process__c) * 100).toFixed(2) || 0;
        var executedNumber = Number(this.executedPercentage);
        this.executedIndicator = Math.floor(executedNumber);
    }

    _setActualizationResults() {
        let results = [];
        
        getActualizationJobEntries({ actualizationJobId: this._currentActualizationJob.Id })
        .then(res => {
            if (res) {
                res.forEach(entry => {
                    let entryPayload = JSON.parse(entry.Payload__c);
                    if (entryPayload.sellLineRecord && entryPayload.sellLineRecord.Id) {
                        entryPayload.SellLineId = '/' + entryPayload.sellLineRecord.Id;
                    }

                    if (entryPayload.placementMonthlySchId) {
                        entryPayload.placementMonthlySchId = '/' + entryPayload.placementMonthlySchId;
                    }else{
                        entryPayload.placementMonthlySchId = '';
                    }

                    try {
                        entryPayload.ErrorMessage = JSON.parse(entryPayload.ErrorMessage)[0].message;
                    } catch (error) {
                        entryPayload.ErrorMessage = entryPayload.ErrorMessage;
                    }

                    results.push(entryPayload);                    
                });

                this.actualizationResults = results;
                this.filteredActualizationResults = this.actualizationResults;
            }

        }).catch(error => {
            this.handleError(error);
        }); 
    }

    _setResultsTableAttributes() {
        this.actualizationTableTitle = "Actualization Results";
        let firstCol = { 
            label: (this.runningRegion === 'NTAM' ? 'Placement Schedule' : 'Sell Line'), 
            fieldName: (this.runningRegion === 'NTAM' ? 'placementMonthlySchId' : 'SellLineId'), 
            type: 'url',
            typeAttributes: { 
                label: { 
                    fieldName: (this.runningRegion === 'NTAM' ? 'campaignID' : 'SellLine')
                },
                 target: '_blank'
            }
        };

        let resultsCols =  [ { label: 'Is Success', fieldName: 'IsSuccess', type: 'boolean' },
                             {  label: 'Error Message', fieldName: 'ErrorMessage', wrapText: true }
                          ];

        // For NTAM results: Push the SFCampaignID column back in for visibility in case no matching Placement Record, to link to, has been found.
        let nTAMCampaignIdCol = { label: 'SF CAMPAIGN ID', fieldName: 'campaignID'};

        this.columns = [firstCol, ...this.runningRegion === 'NTAM' ? [nTAMCampaignIdCol] : [], ...this._getColumnsForRegion(this.runningRegion)];
        this.columns.push(...resultsCols);
    }

    showToast(title, message, variant) {
        const event = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant,
        });
        this.dispatchEvent(event);
    }

    handleNotifyWhenComplete() {
        const fields = {};
        fields[NOTIFY_WHEN_COMPLETE_FIELD.fieldApiName] = true;

        if (!this._currentActualizationJob.Id) {
            this.handleError('The actualization job is not found. Please try again later.');
            return;
        }

        fields['Id'] = this._currentActualizationJob.Id;

        const recordInput = { fields };

        updateRecord(recordInput)
            .then(() => {
                this.isNotifyWhenComplete  = true;
                this.showToast('Success', 'You will get an e-mail & notification when the actualization is completed.', 'success');
            })
            .catch(error => {
                this.handleError(error);
            });
    }

    handleErrorMessageChange(event) {
        let searchText = event.target.value;
        if (searchText) {
            this.filteredActualizationResults = this.actualizationResults.filter(result => {
                return result.ErrorMessage?.toLowerCase().includes(searchText?.toLowerCase());
            });
        }
    } 

    handleSellLineChange(event) {
        let searchText = event.target.value;
        this.filteredActualizationResults = this.actualizationResults.filter(result => {
            return result.SellLine?.toLowerCase().includes(searchText?.toLowerCase());
        });
    } 
    
    handleRadioChange(event) {
        this.selectedOption = event.detail.value;
        if (this.selectedOption == 'all') {
            this.filteredActualizationResults = this.actualizationResults;
        } else {

            this.filteredActualizationResults = this.actualizationResults.filter(result => {
                return String(result.IsSuccess).toLowerCase() === String(this.selectedOption).toLowerCase() ;
            });
        }
    }

    resetFilters() {
        this.filteredActualizationResults = this.actualizationResults
        let textInputs = this.template.querySelectorAll('lightning-input');
        textInputs.forEach(input => {
            input.value = '';
        });

        let radioInp = this.template.querySelectorAll('lightning-radio-group');
        radioInp.forEach(input => {
            input.value = 'all';
        });
    }

    setupSelectedRegion(event){
        this.runningRegion = event.detail.value;
        this._prepareActualizationToolForRegion();
    }

    _prepareActualizationToolForRegion() {
        this.columns = this._getColumnsForRegion(this.runningRegion);
        this.fileDownloadLabel = this.runningRegion === 'NTAM' ? 'Download Sample File' : 'Download Template';
        this._getDefaultExcelFile();
        this._getCurrentActualizationJob(); 
    }
}