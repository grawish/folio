#include <mach-o/dyld.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Folio's fixed-entry Biber launcher. No PAR extraction and no arbitrary script
 * selection. These opaque declarations match proto.h/perl.h in Perl 5.32.1 with
 * MULTIPLICITY; packaging requires the exact reviewed libperl bytes before use.
 * See docs/MAC_SIGNING.md for the ABI evidence and release qualification limits. */
typedef struct interpreter PerlInterpreter;
typedef struct cv CV;
extern void Perl_sys_init3(int *, char ***, char ***);
extern void Perl_sys_term(void);
extern PerlInterpreter *perl_alloc(void);
extern void perl_construct(PerlInterpreter *);
extern int perl_parse(PerlInterpreter *, void (*)(PerlInterpreter *), int, char **, char **);
extern int perl_run(PerlInterpreter *);
extern int perl_destruct(PerlInterpreter *);
extern void perl_free(PerlInterpreter *);
extern CV *Perl_newXS(PerlInterpreter *, const char *, void (*)(PerlInterpreter *, CV *), const char *);
extern void boot_DynaLoader(PerlInterpreter *, CV *);

static void modules(PerlInterpreter *p) {
  Perl_newXS(p, "DynaLoader::boot_DynaLoader", boot_DynaLoader, "folio-biber-launcher.c");
}

int main(int argc, char **argv, char **env) {
  if (argc < 1 || argc > 65536) return 70;
  char executable[PATH_MAX], resolved[PATH_MAX], library[PATH_MAX], script[PATH_MAX];
  uint32_t size = sizeof executable;
  if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) return 70;
  char *slash = strrchr(resolved, '/');
  if (!slash) return 70;
  *slash = '\0';
  int a = snprintf(library, sizeof library, "%s/biber-cache/inc/lib", resolved);
  int b = snprintf(script, sizeof script, "%s/biber-cache/inc/script/biber-darwin", resolved);
  if (a < 0 || a >= PATH_MAX || b < 0 || b >= PATH_MAX) return 70;
  const char *clear[] = {"PERL5LIB", "PERLLIB", "PERL5OPT", "PERLIO", "PERL_UNICODE", NULL};
  for (int i = 0; clear[i]; i++) {
    if (unsetenv(clear[i]) != 0) return 70;
  }
  extern char **environ;
  env = environ;
  char **args = calloc((size_t)argc + 7, sizeof *args);
  if (!args) return 70;
  int n = 0;
  args[n++] = argv[0];
  args[n++] = "-e";
  args[n++] = "BEGIN { @INC = (shift @ARGV) } my $file = shift @ARGV; $0 = $file; "
              "my $ok = do $file; die $@ if $@; die $! unless defined $ok;";
  args[n++] = "--";
  args[n++] = library;
  args[n++] = script;
  for (int i = 1; i < argc; i++) args[n++] = argv[i];
  Perl_sys_init3(&argc, &argv, &env);
  PerlInterpreter *p = perl_alloc();
  if (!p) return 70;
  perl_construct(p);
  int result = perl_parse(p, modules, n, args, NULL);
  if (!result) result = perl_run(p);
  perl_destruct(p);
  perl_free(p);
  Perl_sys_term();
  free(args);
  return result;
}
