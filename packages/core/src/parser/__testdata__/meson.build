project('synapse-app', 'c', 'cpp',
  version: '0.3.0',
  license: 'MIT',
  default_options: ['cpp_std=c++17'],
)

glib_dep = dependency('glib-2.0', version: '>= 2.50')
gio_dep = dependency('gio-2.0')
json_dep = dependency('json-glib-1.0', required: false)

conf_data = configuration_data()
conf_data.set('VERSION', meson.project_version())
configure_file(input: 'config.h.in', output: 'config.h', configuration: conf_data)

src_files = files('src/main.c', 'src/app.c', 'src/utils.c')

synapse_lib = shared_library('synapse',
  src_files,
  dependencies: [glib_dep, gio_dep],
  install: true,
)

synapse_static = static_library('synapse-static',
  src_files,
  dependencies: [glib_dep],
)

synapse_exe = executable('synapse-cli',
  'src/cli.c',
  link_with: synapse_lib,
  dependencies: [glib_dep],
  install: true,
)

subdir('src')
subdir('tests')
subdir('data')

test_exe = executable('test-runner', 'tests/test_main.c',
  link_with: synapse_lib,
  dependencies: [glib_dep],
)
test('unit-tests', test_exe)

custom_gen = custom_target('generate-resources',
  input: 'data/resources.xml',
  output: 'resources.c',
  command: ['glib-compile-resources', '@INPUT@', '--generate-source', '--target=@OUTPUT@'],
)

install_headers('include/synapse.h')
install_data('data/config.json', install_dir: get_option('datadir'))

# TODO: add pkg-config file generation
pkg_mod = import('pkgconfig')
