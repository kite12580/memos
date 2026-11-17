// Package jpegmeta reads and removes JPEG metadata without decoding the
// image. The compressed image data is copied unchanged, so stripping costs
// neither the memory of a decoded image nor the quality of a re-encode.
package jpegmeta

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"

	"github.com/pkg/errors"
)

// ErrNotJPEG reports input that does not start with a JPEG SOI marker.
var ErrNotJPEG = errors.New("not a JPEG")

const (
	markerSOI   = 0xD8
	markerEOI   = 0xD9
	markerSOS   = 0xDA
	markerRST0  = 0xD0
	markerRST7  = 0xD7
	markerAPP0  = 0xE0
	markerAPP1  = 0xE1
	markerAPP14 = 0xEE
	markerAPP15 = 0xEF
	markerCOM   = 0xFE
	markerSOF0  = 0xC0
	markerSOF15 = 0xCF
	markerDHT   = 0xC4
	markerJPG   = 0xC8
	markerDAC   = 0xCC

	exifOrientationTag = 0x0112
)

// Strip copies the JPEG in r to w without its metadata: every APPn segment
// except the JFIF header and the Adobe color transform, comments, and
// anything after the end-of-image marker, such as appended preview images.
// An EXIF orientation other than the default is kept as the only EXIF tag,
// so the image still displays upright.
func Strip(r io.Reader, w io.Writer) error {
	br := bufio.NewReader(r)
	bw := bufio.NewWriter(w)
	var soi [2]byte
	if _, err := io.ReadFull(br, soi[:]); err != nil || soi != [2]byte{0xFF, markerSOI} {
		return ErrNotJPEG
	}
	if _, err := bw.Write(soi[:]); err != nil {
		return err
	}

	seenFrame, seenScan, seenExif := false, false, false
	marker, err := readMarker(br)
	for {
		if err != nil {
			return errors.Wrap(err, "malformed JPEG")
		}
		switch {
		case marker == markerEOI:
			if !seenFrame || !seenScan {
				return errors.New("JPEG has no image data")
			}
			if _, err := bw.Write([]byte{0xFF, markerEOI}); err != nil {
				return err
			}
			return bw.Flush()
		case marker < markerSOF0 || (marker >= markerRST0 && marker <= markerRST7):
			return errors.Errorf("unexpected JPEG marker 0x%02X", marker)
		}

		var payload []byte
		if payload, err = readSegment(br); err != nil {
			return errors.Wrap(err, "malformed JPEG")
		}
		switch {
		case marker == markerAPP0:
			if jfif, ok := normalizedJFIF(payload); ok {
				err = writeSegment(bw, markerAPP0, jfif)
			}
		case marker == markerAPP1:
			if !seenExif && bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
				seenExif = true
				if orientation := exifOrientation(payload[6:]); orientation > 1 && orientation <= 8 {
					err = writeSegment(bw, markerAPP1, orientationExif(orientation))
				}
			}
		case marker == markerAPP14:
			if bytes.HasPrefix(payload, []byte("Adobe")) {
				err = writeSegment(bw, markerAPP14, payload)
			}
		case marker > markerAPP0 && marker <= markerAPP15, marker == markerCOM:
		default:
			if marker >= markerSOF0 && marker <= markerSOF15 && marker != markerDHT && marker != markerJPG && marker != markerDAC {
				seenFrame = true
			}
			err = writeSegment(bw, marker, payload)
		}
		if err != nil {
			return err
		}

		if marker == markerSOS {
			seenScan = true
			marker, err = copyEntropyCodedData(br, bw)
		} else {
			marker, err = readMarker(br)
		}
	}
}

// Orientation returns the EXIF orientation of the JPEG in r, from 1 to 8, or
// 0 when r is not a JPEG or declares none.
func Orientation(r io.Reader) int {
	br := bufio.NewReader(r)
	var soi [2]byte
	if _, err := io.ReadFull(br, soi[:]); err != nil || soi != [2]byte{0xFF, markerSOI} {
		return 0
	}
	for {
		marker, err := readMarker(br)
		if err != nil || marker < markerSOF0 || marker == markerSOS || marker == markerEOI || (marker >= markerRST0 && marker <= markerRST7) {
			return 0
		}
		payload, err := readSegment(br)
		if err != nil {
			return 0
		}
		if marker == markerAPP1 && bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
			if orientation := exifOrientation(payload[6:]); orientation >= 1 && orientation <= 8 {
				return int(orientation)
			}
			return 0
		}
	}
}

// readMarker reads the next marker, skipping the fill bytes that may precede it.
func readMarker(br *bufio.Reader) (byte, error) {
	b, err := br.ReadByte()
	if err != nil {
		return 0, err
	}
	if b != 0xFF {
		return 0, errors.Errorf("expected JPEG marker, found 0x%02X", b)
	}
	for {
		b, err = br.ReadByte()
		if err != nil {
			return 0, err
		}
		if b != 0xFF {
			return b, nil
		}
	}
}

func readSegment(br *bufio.Reader) ([]byte, error) {
	var length uint16
	if err := binary.Read(br, binary.BigEndian, &length); err != nil {
		return nil, err
	}
	if length < 2 {
		return nil, errors.Errorf("invalid JPEG segment length %d", length)
	}
	payload := make([]byte, length-2)
	if _, err := io.ReadFull(br, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeSegment(bw *bufio.Writer, marker byte, payload []byte) error {
	if len(payload) > 0xFFFF-2 {
		return errors.New("JPEG segment too long")
	}
	header := []byte{0xFF, marker, 0, 0}
	binary.BigEndian.PutUint16(header[2:], uint16(len(payload)+2))
	if _, err := bw.Write(header); err != nil {
		return err
	}
	_, err := bw.Write(payload)
	return err
}

// copyEntropyCodedData copies the scan data that follows an SOS header,
// including stuffed bytes and restart markers, and returns the marker that
// ends it.
func copyEntropyCodedData(br *bufio.Reader, bw *bufio.Writer) (byte, error) {
	for {
		chunk, err := br.ReadSlice(0xFF)
		if errors.Is(err, bufio.ErrBufferFull) {
			if _, err := bw.Write(chunk); err != nil {
				return 0, err
			}
			continue
		}
		if err != nil {
			return 0, err
		}
		if _, err := bw.Write(chunk[:len(chunk)-1]); err != nil {
			return 0, err
		}
		next, err := br.ReadByte()
		for err == nil && next == 0xFF {
			next, err = br.ReadByte()
		}
		if err != nil {
			return 0, err
		}
		if next != 0x00 && (next < markerRST0 || next > markerRST7) {
			return next, nil
		}
		if _, err := bw.Write([]byte{0xFF, next}); err != nil {
			return 0, err
		}
	}
}

// normalizedJFIF returns the JFIF header without its embedded thumbnail.
func normalizedJFIF(payload []byte) ([]byte, bool) {
	if len(payload) < 14 || !bytes.HasPrefix(payload, []byte("JFIF\x00")) {
		return nil, false
	}
	jfif := bytes.Clone(payload[:14])
	jfif[12], jfif[13] = 0, 0
	return jfif, true
}

// exifOrientation returns the orientation tag of the first IFD in a TIFF
// structure, or 0 when it has none.
func exifOrientation(tiff []byte) uint16 {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	offset := int(order.Uint32(tiff[4:8]))
	if offset < 8 || offset+2 > len(tiff) {
		return 0
	}
	count := int(order.Uint16(tiff[offset:]))
	entries := tiff[offset+2:]
	for i := 0; i < count && (i+1)*12 <= len(entries); i++ {
		entry := entries[i*12 : (i+1)*12]
		if order.Uint16(entry) == exifOrientationTag {
			return order.Uint16(entry[8:])
		}
	}
	return 0
}

// orientationExif returns an EXIF payload whose only tag is the orientation.
func orientationExif(orientation uint16) []byte {
	payload := []byte("Exif\x00\x00MM\x00\x2A\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00")
	binary.BigEndian.PutUint16(payload[24:], orientation)
	return payload
}
