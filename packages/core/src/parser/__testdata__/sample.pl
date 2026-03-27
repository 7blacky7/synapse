#!/usr/bin/perl
package Synapse::Agent;

use strict;
use warnings;
use Carp;
use JSON::XS;
use LWP::UserAgent;

use constant MAX_RETRIES => 3;
use constant DEFAULT_MODEL => 'claude-opus-4-6';

our $VERSION = '1.0.0';
my $agent_count = 0;

sub new {
    my ($class, %args) = @_;
    my $self = bless {
        name        => $args{name} || croak("name required"),
        model       => $args{model} || DEFAULT_MODEL,
        max_tokens  => $args{max_tokens} || 4096,
        status      => 'idle',
        _tools      => ['search', 'read', 'write'],
    }, $class;
    $agent_count++;
    return $self;
}

sub process {
    my ($self, $message) = @_;
    croak("Empty message") unless defined $message && length $message;
    $self->{status} = 'active';
    my $result = $self->_call_model($message);
    $self->{status} = 'idle';
    return $result;
}

sub get_tools {
    my ($self) = @_;
    return @{$self->{_tools}};
}

sub status {
    my ($self) = @_;
    return $self->{status};
}

sub _call_model {
    my ($self, $message) = @_;
    # TODO: implement actual API call
    return "Response to: $message";
}

sub DESTROY {
    my ($self) = @_;
    $agent_count--;
}

sub _validate {
    my ($self, $input) = @_;
    return defined $input && length($input) > 0;
}

1;

# FIXME: add proper error handling
