#include <stdint.h>
#include <stdio.h>
#include <errno.h>
#include <stdlib.h>
#include <signal.h>
#include <math.h>
#include <stdbool.h>
#include <sys/shm.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <sys/time.h>
#include <turbojpeg.h>
#include <unistd.h>
#include <sys/stat.h>

#define FRAME  30000
#define PERIOD 6000000
#define BPP    4

Display* dsp;
volatile Window active_window;
volatile Window temp_window_id;

struct shmimage
{
    XShmSegmentInfo shminfo;
    XImage * ximage;
    unsigned int * data; // BGRA
};

struct shmimage _src;
struct shmimage * src = &_src;

void initimage(struct shmimage * image)
{
    image->ximage = NULL;
    image->shminfo.shmaddr = (char *) -1;
}

void destroyimage(struct shmimage * image)
{
    if (image->ximage)
    {
        XShmDetach(dsp, &image->shminfo);
        XDestroyImage(image->ximage);
        image->ximage = NULL;
    }

    if (image->shminfo.shmaddr != (char *) -1)
    {
        shmdt(image->shminfo.shmaddr);
        image->shminfo.shmaddr = (char *) -1;
    }
}

int createimage(struct shmimage * image, int width, int height)
{
    // Create a shared memory area
    image->shminfo.shmid = shmget(IPC_PRIVATE, width * height * BPP, IPC_CREAT | 0600);
    if (image->shminfo.shmid == -1)
    {
        return false;
    }

    // Map the shared memory segment into the address space of this process
    image->shminfo.shmaddr = (char *) shmat(image->shminfo.shmid, 0, 0);
    if (image->shminfo.shmaddr == (char *) -1)
    {
        return false;
    }

    image->data = (unsigned int*) image->shminfo.shmaddr;
    image->shminfo.readOnly = false;

    // Mark the shared memory segment for removal
    // It will be removed even if this program crashes
    shmctl(image->shminfo.shmid, IPC_RMID, 0);

    // Allocate the memory needed for the XImage structure
    image->ximage = XShmCreateImage(dsp, XDefaultVisual(dsp, XDefaultScreen(dsp)),
                        DefaultDepth(dsp, XDefaultScreen(dsp)), ZPixmap, 0,
                        &image->shminfo, 0, 0);

    if (!image->ximage)
    {
        destroyimage(image);
        return false;
    }

    image->ximage->data = (char *) image->data;
    image->ximage->width = width;
    image->ximage->height = height;

    // Ask the X server to attach the shared memory segment and sync
    XShmAttach(dsp, &image->shminfo);
    XSync(dsp, false);
    return true;
}

void getrootwindow()
{
    XShmGetImage(dsp, active_window, src->ximage, 0, 0, AllPlanes);
}

long timestamp()
{
   struct timeval tv;
   gettimeofday(&tv, 0);
   return tv.tv_sec*1000000L + tv.tv_usec;
}

int run()
{
    XEvent xevent;
    long framets = timestamp();
    long periodts = timestamp();
    long frames = 0;
    int fd = ConnectionNumber(dsp);

    while (1)
    {
        if (!active_window) {
            pause();
            continue;
        }

        while (XPending(dsp))
        {
            XNextEvent(dsp, &xevent);
        }

        getrootwindow();

        int w = src->ximage->width;
        int h = src->ximage->height;
        int bpp = BPP;

        printf("%d", 0xDEADBEEF);
        fwrite(&w, 2, 1, stdout);
        fwrite(&h, 2, 1, stdout);
        fwrite(&bpp, 2, 1, stdout);
        printf("%d", 0xDEAFBEEF);
        fwrite(src->ximage->data, w * h * BPP, 1, stdout);
        printf("%d", 0xDAEBAAAA);

        XSync(dsp, False);

        int frameus = timestamp() - framets;
        ++frames;
        while(frameus < FRAME)
        {
            #if defined(__SLEEP__)
            usleep(FRAME - frameus);
            #endif
            frameus = timestamp() - framets;
        }
        framets = timestamp();

        int periodus = timestamp() - periodts;
        if (periodus >= PERIOD)
        {
            frames = 0;
            periodts = framets;
        }

    }
    return true;
}

int handler(Display *, XErrorEvent *) {
    return 0;
}

void handle_signal(int sig) {
    FILE* windowIdFile = fopen(".window", "r");
    fscanf(windowIdFile, "%d", &temp_window_id);
    fclose(windowIdFile);

    XWindowAttributes attrs;
    XGetWindowAttributes(dsp, temp_window_id, &attrs);

    int width = attrs.width;
    int height = attrs.height;

    initimage(src);
    createimage(src, width, height);
    active_window = temp_window_id;
    temp_window_id = 0;

    signal(SIGUSR1, handle_signal);
}

int main(int argc, char * argv[])
{
    setvbuf(stdout, NULL, _IONBF, 0);

    FILE *pidFile = fopen(".pid", "w");
    fprintf(pidFile, "%d", getpid());
    fclose(pidFile);

    dsp = XOpenDisplay(NULL);
    int screen = XDefaultScreen(dsp);

    signal(SIGUSR1, handle_signal);
    XSetErrorHandler(handler);

    initimage(src);
    run();

    destroyimage(src);
    XCloseDisplay(dsp);
    return 0;
}
