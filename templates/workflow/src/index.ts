// kind:"workflow" marketplace extension. The workflow DAG is authored as a
// Cinatra BPMN Profile sidecar at `cinatra/workflow.bpmn`, parsed + compiled to
// a WorkflowSpec at install time. The optional `cinatra/dashboard.json` declares
// the operator dashboard's portlet composition. There is no runtime code
// surface — this marker file keeps the package a valid module.
export {};
