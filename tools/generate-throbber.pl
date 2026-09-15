#!/usr/bin/perl
# Generates the boot splash's spinner frames: a thin ring arc whose tail
# fades out, rotated a few degrees per frame. Pure Perl with Compress::Zlib
# (both in every Debian base install), so the frames can be regenerated on a
# machine with nothing else on it. Run from the repository root:
#
#   perl tools/generate-throbber.pl
#
# Overwrites agent/internal/apply/assets/bootsplash/throbber-NN.png. The
# frame count and size here must agree with odm-boot.script.
use strict;
use warnings;
use Compress::Zlib;
use Math::Trig;

my $frames   = 72;    # 5 degrees apart: a hand-off that reads as a turn, not a series of jumps
my $size     = 64;    # px; the script does not scale these, so this is the on-screen size
my $stroke   = 5.0;   # px
my $arc      = 0.78;  # fraction of the full circle the arc covers
my $ss       = 4;     # supersampling per axis, for anti-aliased edges
my $out_dir  = "agent/internal/apply/assets/bootsplash";

my @crc_table;
for my $n (0 .. 255) {
    my $c = $n;
    for (1 .. 8) { $c = ($c & 1) ? (0xEDB88320 ^ ($c >> 1)) : ($c >> 1) }
    $crc_table[$n] = $c;
}
sub png_crc {
    my $c = 0xFFFFFFFF;
    for my $b (unpack 'C*', $_[0]) { $c = $crc_table[($c ^ $b) & 0xFF] ^ ($c >> 8) }
    return ($c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
}
sub chunk { my ($type, $data) = @_; return pack('N', length $data) . $type . $data . pack('N', png_crc($type . $data)) }

my $centre = $size / 2;
my $radius = $centre - $stroke / 2 - 1.5;

for my $frame (0 .. $frames - 1) {
    my $head = 2 * pi * $frame / $frames;   # where the bright end of the arc is
    my $raw = '';
    for my $y (0 .. $size - 1) {
        $raw .= "\0";                        # filter type: none
        for my $x (0 .. $size - 1) {
            my $alpha = 0;
            for my $sy (0 .. $ss - 1) {
                for my $sx (0 .. $ss - 1) {
                    my $px = $x + ($sx + 0.5) / $ss - $centre;
                    my $py = $y + ($sy + 0.5) / $ss - $centre;
                    my $d  = sqrt($px * $px + $py * $py);
                    next if abs($d - $radius) > $stroke / 2;
                    # Angle back from the head, in [0, 1) of a full turn.
                    my $angle = atan2($py, $px);
                    my $back  = ($head - $angle) / (2 * pi);
                    $back -= int($back);
                    $back += 1 if $back < 0;
                    next if $back > $arc;
                    # Round caps, so the ends of the arc are not cut square.
                    my $edge = $stroke / 2 - abs($d - $radius);
                    my $cap  = 1;
                    for my $end (0, $arc) {
                        my $along = abs($back - $end) * 2 * pi * $radius;   # px along the arc from this end
                        if ($along < $stroke / 2) {
                            my $r2 = ($stroke / 2) ** 2 - $along ** 2;
                            $cap = 0 if $r2 < 0 || ($d - $radius) ** 2 > $r2;
                        }
                    }
                    next unless $cap;
                    # Fade from the head to the tail, gently rather than linearly.
                    $alpha += (1 - $back / $arc) ** 1.4;
                }
            }
            $alpha /= $ss * $ss;
            $raw .= pack('CCCC', 255, 255, 255, int($alpha * 255 + 0.5));
        }
    }
    my $png = pack('C8', 137, 80, 78, 71, 13, 10, 26, 10)
        . chunk('IHDR', pack('NNCCCCC', $size, $size, 8, 6, 0, 0, 0))
        . chunk('IDAT', compress($raw, 9))
        . chunk('IEND', '');
    my $path = sprintf('%s/throbber-%02d.png', $out_dir, $frame);
    open(my $fh, '>:raw', $path) or die "$path: $!";
    print $fh $png;
    close $fh;
}
printf "wrote %d frames of %dx%d to %s\n", $frames, $size, $size, $out_dir;
