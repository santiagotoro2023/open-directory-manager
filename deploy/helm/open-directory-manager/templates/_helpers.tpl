{{- define "odm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "odm.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "odm.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "odm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels of one component: control-plane, ntfy, database, node */}}
{{- define "odm.selector" -}}
app.kubernetes.io/name: {{ include "odm.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Pods that answer on the console's public address */}}
{{- define "odm.publicLabel" -}}
open-directory-manager/public: {{ .Release.Name | quote }}
{{- end }}

{{- define "odm.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{- define "odm.nodeImage" -}}
{{ .Values.nodeImage.repository }}:{{ .Values.nodeImage.tag | default .Chart.AppVersion }}
{{- end }}

{{- define "odm.consoleFqdn" -}}
{{ .Values.console.name }}.{{ .Values.domain.name | lower }}
{{- end }}

{{- define "odm.sharedClaim" -}}
{{- .Values.sharedData.existingClaim | default (printf "%s-shared" (include "odm.fullname" .)) }}
{{- end }}

{{/* The Secret with the database URL */}}
{{- define "odm.dbSecret" -}}
{{- .Values.database.existingSecret | default (printf "%s-db" (include "odm.fullname" .)) }}
{{- end }}

{{/* Password of the bundled database: given, kept from the existing Secret, or new */}}
{{- define "odm.dbPassword" -}}
{{- if .Values.database.password }}
{{- .Values.database.password }}
{{- else }}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-db" (include "odm.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "password") }}
{{- index $s.data "password" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}

{{- define "odm.adminSecret" -}}
{{- .Values.domain.existingSecret | default (printf "%s-admin" (include "odm.fullname" .)) }}
{{- end }}

{{/* The Administrator password: given, kept from the existing Secret, or new.
     Samba wants upper, lower and a digit in it. */}}
{{- define "odm.adminPassword" -}}
{{- if .Values.domain.adminPassword }}
{{- .Values.domain.adminPassword }}
{{- else }}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-admin" (include "odm.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "password") }}
{{- index $s.data "password" | b64dec }}
{{- else }}
{{- printf "Odm-%s-%s9" (randAlphaNum 20) (randAlpha 4 | upper) }}
{{- end }}
{{- end }}
{{- end }}

{{/* Every machine of the domain, controllers first: name, address, role */}}
{{- define "odm.machines" -}}
{{- $out := list }}
{{- range $i, $dc := .Values.domainControllers }}
{{- $out = append $out (dict "node" $dc.node "hostname" ($dc.hostname | default $dc.node) "address" $dc.address "role" "domain-controller" "index" $i "kind" "dc") }}
{{- end }}
{{- range $i, $m := .Values.memberServers }}
{{- $out = append $out (dict "node" $m.node "hostname" ($m.hostname | default $m.node) "address" $m.address "role" "member" "index" $i "kind" "srv") }}
{{- end }}
{{- toJson $out }}
{{- end }}

{{/* The controllers' addresses, comma separated */}}
{{- define "odm.dcAddresses" -}}
{{- $a := list }}
{{- range .Values.domainControllers }}{{ $a = append $a .address }}{{ end }}
{{- join "," $a }}
{{- end }}

{{/* The controllers' names, as the control plane reaches them */}}
{{- define "odm.dcNames" -}}
{{- $n := list }}
{{- range .Values.domainControllers }}{{ $n = append $n (printf "%s.%s" ((.hostname | default .node) | lower) ($.Values.domain.name | lower)) }}{{ end }}
{{- join " " $n }}
{{- end }}

{{/* Settings shared by the API and the notification server */}}
{{- define "odm.controlPlaneEnv" -}}
- name: ODM_REALM
  value: {{ .Values.domain.realm | upper | quote }}
- name: ODM_DOMAIN
  value: {{ .Values.domain.name | lower | quote }}
{{- with .Values.domain.netbios }}
- name: ODM_NETBIOS
  value: {{ . | quote }}
{{- end }}
- name: ODM_DOMAIN_CONTROLLERS
  value: {{ include "odm.dcNames" . | quote }}
- name: ODM_CONSOLE_URL
  value: {{ printf "https://%s:%v" (include "odm.consoleFqdn" .) .Values.console.port | quote }}
- name: ODM_PORT
  value: {{ .Values.console.port | quote }}
- name: ODM_NTFY_PORT
  value: {{ .Values.ntfy.port | quote }}
{{- with .Values.console.extraCertificateNames }}
- name: ODM_CERTIFICATE_NAMES
  value: {{ join " " . | quote }}
{{- end }}
{{- end }}

{{/* The domain's machines, by name, for pods that do not use the domain's DNS */}}
{{- define "odm.hostAliases" -}}
{{- range (include "odm.machines" . | fromJsonArray) }}
- ip: {{ .address | quote }}
  hostnames:
    - {{ printf "%s.%s" (.hostname | lower) ($.Values.domain.name | lower) | quote }}
    - {{ .hostname | lower | quote }}
{{- end }}
{{- end }}
