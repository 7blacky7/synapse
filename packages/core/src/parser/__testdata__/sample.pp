class synapse::agent (
  String $model        = 'claude-opus-4-6',
  Integer $max_tokens  = 4096,
  Float $temperature   = 0.7,
  Boolean $enabled     = true,
  Array[String] $tools = ['search', 'read', 'write'],
  Enum['active', 'idle', 'stopped'] $status = 'idle',
) {

  $max_retries = 3
  $config_dir = '/etc/synapse'
  $data_dir = '/var/lib/synapse'
  $log_dir = '/var/log/synapse'

  include synapse::prerequisites
  require synapse::install

  package { 'synapse-agent':
    ensure => latest,
  }

  file { $config_dir:
    ensure => directory,
    owner  => 'synapse',
    group  => 'synapse',
    mode   => '0750',
  }

  file { "${config_dir}/agent.yaml":
    ensure  => file,
    content => template('synapse/agent.yaml.erb'),
    owner   => 'synapse',
    notify  => Service['synapse-agent'],
  }

  service { 'synapse-agent':
    ensure    => running,
    enable    => true,
    subscribe => File["${config_dir}/agent.yaml"],
  }

  exec { 'synapse-health-check':
    command => '/usr/bin/curl -sf http://localhost:3000/health',
    require => Service['synapse-agent'],
  }

  cron { 'synapse-cleanup':
    command => '/usr/bin/synapse-cleanup --max-age 7d',
    hour    => 2,
    minute  => 0,
  }

  define agent_instance (
    String $agent_name = $title,
    String $agent_model = $model,
  ) {
    file { "${config_dir}/agents/${agent_name}.yaml":
      ensure  => file,
      content => template('synapse/instance.yaml.erb'),
    }
  }

  node 'agent-server' {
    include synapse::agent
  }

  # TODO: add monitoring integration
  # FIXME: handle service restart gracefully
}
