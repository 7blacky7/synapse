// Synapse Kubernetes Deployment Configuration

local config = import 'config.libsonnet';
local utils = import '../lib/utils.libsonnet';
local templates = import 'templates/base.jsonnet';
local version = importstr 'VERSION';

// Helper functions
local labelSelector(name) = {
  'app.kubernetes.io/name': name,
  'app.kubernetes.io/part-of': 'synapse',
};

local containerPort(name, port) = {
  name: name,
  containerPort: port,
  protocol: 'TCP',
};

local envVar(name, value) =
  { name: name, value: std.toString(value) };

local envFromSecret(name, secretName, key) =
  { name: name, valueFrom: { secretKeyRef: { name: secretName, key: key } } };

// Main configuration
local namespace = 'synapse';
local replicas = 3;
local imageTag = config.version;

{
  // Deployment
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'synapse-api',
    namespace: namespace,
    labels: labelSelector('synapse-api'),
  },
  spec: {
    replicas: replicas,
    selector: {
      matchLabels: labelSelector('synapse-api'),
    },
    template: {
      metadata: {
        labels: labelSelector('synapse-api'),
        annotations:: {
          'prometheus.io/scrape': 'true',
          'prometheus.io/port': '9090',
        },
      },
      spec: {
        containers: [
          {
            name: 'api',
            image: 'synapse/api:' + imageTag,
            ports: [
              containerPort('http', 3000),
              containerPort('metrics', 9090),
            ],
            env: [
              envVar('NODE_ENV', 'production'),
              envVar('PORT', 3000),
              envFromSecret('DATABASE_URL', 'synapse-secrets', 'database-url'),
              envFromSecret('QDRANT_URL', 'synapse-secrets', 'qdrant-url'),
            ],
            resources: {
              requests: { cpu: '250m', memory: '512Mi' },
              limits: { cpu: '1000m', memory: '2Gi' },
            },
            livenessProbe: {
              httpGet: { path: '/health', port: 'http' },
              initialDelaySeconds: 15,
            },
            readinessProbe: {
              httpGet: { path: '/ready', port: 'http' },
              initialDelaySeconds: 5,
            },
          },
        ],
        serviceAccountName: 'synapse-api',
        // Hidden field for internal use
        nodeSelector::: { 'kubernetes.io/os': 'linux' },
      },
    },
  },

  // Service
  service: {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'synapse-api',
      namespace: namespace,
    },
    spec: {
      selector: labelSelector('synapse-api'),
      ports: [
        { name: 'http', port: 80, targetPort: 'http' },
      ],
    },
  },

  // ConfigMap
  "config-map": {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'synapse-config',
      namespace: namespace,
    },
    data: {
      'config.json': std.manifestJsonEx(config, '  '),
    },
  },

  // TODO: add HPA for auto-scaling
  # FIXME: ingress TLS configuration missing
}
