#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <sys/shm.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <cairo.h>
#include <cairo-xlib.h>
#include <signal.h>
#include <unistd.h>

#define BPP    4

int current_frame = 0;
Window temp_window_id = 0;
Window active_window;
Display* dsp = NULL;
struct shmimage _src;
struct shmimage* src;

struct shmimage
{
    XShmSegmentInfo shminfo;
    XImage * ximage;
    unsigned int * data;
};

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
    image->shminfo.shmid = shmget(IPC_PRIVATE, width * height * BPP, IPC_CREAT | 0600);
    if (image->shminfo.shmid == -1)
    {
        return false;
    }

    image->shminfo.shmaddr = (char *) shmat(image->shminfo.shmid, 0, 0);
    if (image->shminfo.shmaddr == (char *) -1)
    {
        return false;
    }

    image->data = (unsigned int*) image->shminfo.shmaddr;
    image->shminfo.readOnly = false;

    shmctl(image->shminfo.shmid, IPC_RMID, 0);

    image->ximage = XShmCreateImage(dsp, XDefaultVisual(dsp, XDefaultScreen(dsp)),
                        DefaultDepth(dsp, XDefaultScreen(dsp)), ZPixmap, 0,
                        &image->shminfo, 0, 0);

    if (!image->ximage)
    {
        destroyimage(image);
        return false;
    }

    image->ximage->data = (char *)image->data;
    image->ximage->width = width;
    image->ximage->height = height;

    XShmAttach(dsp, &image->shminfo);
    XSync(dsp, false);
    return true;
}

static cairo_status_t buffer_write(void* metadata, const unsigned char *data, unsigned int length)
{
    return fwrite((char*) data, 1, length, stdout) ? CAIRO_STATUS_SUCCESS : CAIRO_STATUS_WRITE_ERROR;
}

int processimage()
{
    int w = src->ximage->width, h = src->ximage->height, x = 0, y = 0;

    cairo_surface_t* sur = cairo_xlib_surface_create(dsp, active_window, DefaultVisual(dsp, DefaultScreen(dsp)), w, h);
    cairo_surface_write_to_png_stream(sur, buffer_write, NULL);
    cairo_surface_destroy(sur);

    return true;
}

int run()
{
    while (1)
    {
        if (!active_window) {
            pause();
            continue;
        }

        XShmGetImage(dsp, active_window, src->ximage, 0, 0, AllPlanes);
        processimage(src);

        XSync(dsp, False);
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

    initimage(&_src);
    createimage(&_src, width, height);
    active_window = temp_window_id;
    temp_window_id = 0;

    signal(SIGUSR1, handle_signal);
}

int main(int argc, char * argv[])
{
    FILE* pidFile = fopen(".pid", "w");
    fprintf(pidFile, "%d", getpid());
    fclose(pidFile);

    src = &_src;

    signal(SIGUSR1, handle_signal);
    XSetErrorHandler(handler);

    dsp = XOpenDisplay(NULL);
    run();
    destroyimage(src);
    XCloseDisplay(dsp);
    return 0;
}
