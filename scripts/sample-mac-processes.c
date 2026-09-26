// Developer-only observer. Build against the installed macOS SDK; never ship
// this executable in Folio. Only the selected PID and its descendants are read.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

#define CAPACITY 512
static void quoted(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
int main(int argc, char **argv) {
  char *end = NULL;
  long selected = argc == 2 ? strtol(argv[1], &end, 10) : 0;
  if (selected <= 0 || selected > INT_MAX || !end || *end) return 2;
  pid_t pids[CAPACITY] = {(pid_t)selected}, parents[CAPACITY] = {0};
  int count = 1, emitted = 0, vanished = 0;
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 5;
  const uint64_t at = mach_absolute_time();
  printf("{\"atAbstime\":\"%" PRIu64 "\",\"timebase\":{\"numer\":%u,\"denom\":%u},\"processes\":[", at, timebase.numer, timebase.denom);
  for (int index = 0; index < count; index++) {
    const pid_t pid = pids[index];
    struct proc_bsdinfo bsd = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd)) {
      if (errno != ESRCH) { fprintf(stderr, "pid info failed (%d): %d\n", pid, errno); return 3; }
      vanished++; continue;
    }
    if (index && bsd.pbi_ppid != (uint32_t)parents[index]) { vanished++; continue; }
    struct rusage_info_v0 usage = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&usage)) {
      if (errno != ESRCH) { fprintf(stderr, "rusage failed (%d): %d\n", pid, errno); return 3; }
      vanished++; continue;
    }
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    proc_pidpath(pid, executable, sizeof(executable));
    const char *name = strrchr(executable, '/');
    name = name ? name + 1 : "unknown";
    if (emitted++) putchar(',');
    printf("{\"pid\":%d,\"parent\":%u,\"name\":", pid, bsd.pbi_ppid);
    quoted(name);
    printf(
      ",\"birthAbstime\":\"%" PRIu64 "\",\"userTicks\":\"%" PRIu64
      "\",\"systemTicks\":\"%" PRIu64 "\",\"rssBytes\":%" PRIu64
      ",\"footprintBytes\":%" PRIu64 "}",
      usage.ri_proc_start_abstime, usage.ri_user_time, usage.ri_system_time,
      usage.ri_resident_size, usage.ri_phys_footprint);
    pid_t children[CAPACITY];
    errno = 0;
    int found = proc_listchildpids(pid, children, sizeof(children));
    if (found < 0 || found >= CAPACITY || (found == 0 && errno && errno != ESRCH)) {
      fprintf(stderr, "child enumeration failed or truncated\n"); return 4;
    }
    if (found == 0 && errno == ESRCH) vanished++;
    for (int i = 0; i < found; i++) {
      if (children[i] <= 0) continue;
      int seen = 0;
      for (int j = 0; j < count; j++) if (pids[j] == children[i]) seen = 1;
      if (seen) continue;
      if (count == CAPACITY) { fprintf(stderr, "process tree exceeds observer capacity\n"); return 4; }
      parents[count] = pid; pids[count++] = children[i];
    }
  }
  struct rusage observer;
  if (getrusage(RUSAGE_SELF, &observer)) return 5;
  double cpu = observer.ru_utime.tv_sec + observer.ru_utime.tv_usec / 1e6
             + observer.ru_stime.tv_sec + observer.ru_stime.tv_usec / 1e6;
  printf("],\"vanished\":%d,\"samplerCpuSeconds\":%.6f}\n", vanished, cpu);
  return 0;
}
