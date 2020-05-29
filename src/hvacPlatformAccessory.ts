import type {PlatformAccessory, Service} from 'homebridge';
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
} from 'homebridge';

import {FlairPlatform} from './platform';
import Client from './client';
import {FlairMode, Room, HVAC, Structure} from './client/models';
import {HVACMode, HVACPowerMode, TemperatureScale} from './client/models/hvac';
import {getRandomIntInclusive} from './utils';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FlairHVACPlatformAccessory {
    private accessoryInformationService: Service;
    private thermostatService: Service;

    private client: Client;
    private hvac: HVAC;
    private room: Room;
    private structure: Structure;


    constructor(
        private readonly platform: FlairPlatform,
        private readonly accessory: PlatformAccessory,
        client: Client,
        room: Room,
        structure: Structure,
    ) {
      this.hvac = this.accessory.context.device;
      this.client = client;
      this.room = room;
      this.structure = structure;

      // set accessory information
      this.accessoryInformationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Flair')
        .setCharacteristic(this.platform.Characteristic.Model, 'HVAC Unit')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.hvac.id!);

      this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat)
          ?? this.accessory.addService(this.platform.Service.Thermostat);
      this.thermostatService.setPrimaryService(true);
      this.thermostatService
        .setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name)
        .setCharacteristic(
          this.platform.Characteristic.TemperatureDisplayUnits,
          this.hvac.temperatureScale === TemperatureScale.F ?
            this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT :
            this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
        )
        .setCharacteristic(this.platform.Characteristic.CurrentTemperature, this.room.currentTemperatureC!)
        .setCharacteristic(this.platform.Characteristic.TargetTemperature, this.hvac.getSetPointC())
        .setCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.getTargetHeatingCoolingStateFromHVAC(this.hvac)!,
        )
        .setCharacteristic(
          this.platform.Characteristic.CurrentHeatingCoolingState,
          this.getCurrentHeatingCoolingStateFromHVAC(this.hvac)!,
        )
        .setCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.room.currentHumidity!);

      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .on(CharacteristicEventTypes.SET, this.setTargetTemperature.bind(this))
        .on(CharacteristicEventTypes.GET, this.getTargetTemperature.bind(this));

      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .on(CharacteristicEventTypes.SET, this.setTargetHeatingCoolingState.bind(this))
        .on(CharacteristicEventTypes.GET, this.getTargetHeatingCoolingState.bind(this));

      setInterval(async () => {
        await this.getNewRoomReadings();
      }, (platform.config.pollInterval+ getRandomIntInclusive(1,20)) * 1000);

      setInterval(async () => {
        await this.getNewHVACReadings();
      }, (platform.config.pollInterval+ getRandomIntInclusive(1,20)) * 1000);

      this.getNewRoomReadings();
      this.getNewHVACReadings();
    }

    getTargetHeatingCoolingState(callback: CharacteristicGetCallback) {
      callback(null, this.getTargetHeatingCoolingStateFromHVAC(this.hvac));
    }

    setTargetHeatingCoolingState(value: CharacteristicValue, callback: CharacteristicSetCallback) {
      if (value === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.platform.setStructureMode(FlairMode.MANUAL).then(() => {
          this.client.setHVACPowerMode(this.hvac, HVACPowerMode.OFF).then(() => {
            callback(null, value);
            this.getNewHVACReadings();
          });
        });
      } else if(value === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
        this.platform.setStructureMode(FlairMode.MANUAL).then(() => {
          this.client.setHVACPowerMode(this.hvac, HVACPowerMode.ON).then((hvac: HVAC) => {
            this.client.setHVACMode(hvac, HVACMode.COOL).then(() => {
              callback(null, value);
              this.getNewHVACReadings();
            });
          });
        });
      } else if(value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
        this.platform.setStructureMode(FlairMode.MANUAL).then(() => {
          this.client.setHVACPowerMode(this.hvac, HVACPowerMode.ON).then((hvac: HVAC) => {
            this.client.setHVACMode(hvac, HVACMode.HEAT).then(() => {
              callback(null, value);
              this.getNewHVACReadings();
            });
          });
        });
      } else if(value === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
        this.platform.setStructureMode(FlairMode.MANUAL).then(() => {
          this.client.setHVACPowerMode(this.hvac, HVACPowerMode.ON).then((hvac: HVAC) => {
            this.client.setHVACMode(hvac, HVACMode.AUTO).then(() => {
              callback(null, value);
              this.getNewHVACReadings();
            });
          });
        });
      }
    }

    setTargetTemperature(value: CharacteristicValue, callback: CharacteristicSetCallback) {
      this.client.setHVACTemperature(this.hvac, value as number).then((hvac: HVAC) => {
        this.updateHVACReadingsFromHVAC(hvac);
        this.platform.log.debug('Set Characteristic Temperature -> ', hvac.convertFromCToSetPointUnits(value as number));
        // you must call the callback function
        callback(null, hvac.convertFromCToSetPointUnits(value as number));
      });

    }

    getTargetTemperature(callback: CharacteristicGetCallback) {
      this.getNewHVACReadings().then((hvac: HVAC) => {
        callback(null, hvac.getSetPointC());
      });
    }

    async getNewHVACReadings(): Promise<HVAC> {
      try {
        const hvac = await this.client.getHVAC(this.hvac);
        this.updateHVACReadingsFromHVAC(hvac);
        return hvac;
      } catch (e) {
        this.platform.log.error(e);
      }

      return this.hvac;
    }


    async getNewRoomReadings(): Promise<Room> {
      try {
        const room = await this.client.getRoom(this.room);
        this.updateRoomReadingsFromRoom(room);
        return room;
      } catch (e) {
        this.platform.log.error(e);
      }

      return this.room;
    }

    public updateFromStructure(structure: Structure) {
      this.structure = structure;
    }

    updateHVACReadingsFromHVAC(hvac: HVAC) {
      this.accessory.context.device = hvac;
      this.hvac = hvac;

      // push the new value to HomeKit
      this.thermostatService
        .updateCharacteristic(
          this.platform.Characteristic.TargetTemperature, this.hvac.getSetPointC(),
        )
        .updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.getTargetHeatingCoolingStateFromHVAC(this.hvac)!,
        )
        .updateCharacteristic(
          this.platform.Characteristic.CurrentHeatingCoolingState,
          this.getCurrentHeatingCoolingStateFromHVAC(this.hvac)!,
        );

      this.platform.log.debug(
        `Pushed updated current hvac state for ${this.room.name!} to HomeKit:`,
        this.hvac.mode!,
      );

      this.platform.log.debug(
        `Pushed updated set point state for ${this.room.name!} to HomeKit:`,
        this.hvac.getSetPointC(),
      );

    }

    updateRoomReadingsFromRoom(room: Room) {
      this.accessory.context.device.room = room;
      this.room = room;

      // push the new value to HomeKit
      this.thermostatService
        .updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.room.currentTemperatureC!)
        .updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.room.currentHumidity!);

      this.platform.log.debug(
        `Pushed updated current temperature state for ${this.room.name!} to HomeKit:`,
        this.room.currentTemperatureC!,
      );

    }

    private getCurrentHeatingCoolingStateFromHVAC(hvac: HVAC) {
      if (hvac.power === HVACPowerMode.OFF) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      }

      if (hvac.mode === HVACMode.COOL) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      }

      if (hvac.mode === HVACMode.HEAT) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      }

      // we assume what the hvac unit is doing because minisplits are one-way
      // communication devices so we can't actually check the device.
      // also assumes the room puck is in the same room as the hvac unit
      if (hvac.mode === HVACMode.AUTO) {
        if (hvac.getSetPointC() < this.room.currentTemperatureC!) {
          return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        } else {
          return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        }
      }
    }


    private getTargetHeatingCoolingStateFromHVAC(hvac: HVAC) {
      if (hvac.power === HVACPowerMode.OFF) {
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      }

      if (hvac.mode === HVACMode.COOL) {
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      }

      if (hvac.mode === HVACMode.HEAT) {
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      }

      if (hvac.mode === HVACMode.AUTO) {
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      }
    }

}
